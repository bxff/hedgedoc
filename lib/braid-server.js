'use strict'

// Braid-text server middleware for HedgeDoc
// Replaces OT server (lib/ot/editor-socketio-server.js) with CRDT-based document sync
//
// This module exposes braid-text resources on /braid/:noteId
// and provides helper functions for realtime.js to manage document state.

const logger = require('./logger')
const braidText = require('braid-text')
const DiffMatchPatch = require('diff-match-patch')
const dmp = new DiffMatchPatch()

// Disable file-system persistence -- HedgeDoc manages its own DB persistence.
// braid-text will keep documents in-memory only.
braidText.db_folder = null

// Track which notes have been loaded into braid-text
const loadedNotes = new Set()

// Track dirty state per note (set when braid-text receives a PUT)
const dirtyNotes = new Set()

// References to realtime.js state (set via init())
let notesRef = null
let modelsRef = null

/**
 * Initialize the braid server with references to realtime.js state.
 * Must be called before any braid requests are handled.
 *
 * @param {Object} notes - The notes object from realtime.js
 * @param {Object} models - The models module (for Author.findOrCreate)
 */
function init (notes, models) {
  notesRef = notes
  modelsRef = models
}

/**
 * Initialize a note's document in braid-text with content from the database.
 * Called when a note is first accessed by any client.
 *
 * @param {string} noteId - The note's ID
 * @param {string} body - The note's current content from the database
 */
async function loadNote (noteId, body) {
  if (loadedNotes.has(noteId)) return
  if (body) {
    await braidText.put(noteId, { body })
  } else {
    // Create empty resource - put with a single empty string body
    await braidText.put(noteId, { body: ' ' })
    // Then delete that space to get a truly empty doc
    await braidText.put(noteId, {
      patches: [{ unit: 'text', range: '[0:1]', content: '' }]
    })
  }
  loadedNotes.add(noteId)
  logger.debug('braid: loaded note ' + noteId)
}

/**
 * Get the current document text for a note.
 *
 * @param {string} noteId - The note's ID
 * @returns {string} The current document text
 */
async function getDocument (noteId) {
  const result = await braidText.get(noteId)
  return result || ''
}

/**
 * Check and clear dirty flag for a note.
 *
 * @param {string} noteId - The note's ID
 * @returns {boolean} Whether the note has been modified since last check
 */
function isDirty (noteId) {
  if (dirtyNotes.has(noteId)) {
    dirtyNotes.delete(noteId)
    return true
  }
  return false
}

/**
 * Unload a note from braid-text (when all clients disconnect).
 *
 * @param {string} noteId - The note's ID
 */
async function unloadNote (noteId) {
  if (!loadedNotes.has(noteId)) return
  try {
    await braidText.delete(noteId)
  } catch (e) {
    logger.debug('braid: error deleting resource ' + noteId + ': ' + e.message)
  }
  loadedNotes.delete(noteId)
  dirtyNotes.delete(noteId)
  logger.debug('braid: unloaded note ' + noteId)
}

/**
 * Check if a user may edit a note, replicating the original ifMayEdit logic.
 *
 * @param {Object} req - Express request object (has req.user from session)
 * @param {Object} note - The note object from notes[noteId]
 * @returns {boolean} Whether the user may edit
 */
function checkEditPermission (req, note) {
  if (!note) return false
  const user = req.user
  switch (note.permission) {
    case 'freely':
      // Anyone can edit
      return true
    case 'editable':
    case 'limited':
      // Only logged-in users can edit
      return !!(user && user.logged_in)
    case 'locked':
    case 'private':
    case 'protected':
      // Only the owner can edit
      return !!(note.owner && user && user.id === note.owner)
    default:
      return true
  }
}

/**
 * Track authorship after a successful PUT, replicating operationCallback.
 *
 * @param {string} noteId - The note's ID
 * @param {Object} req - Express request object
 */
function trackAuthorship (noteId, req) {
  if (!notesRef || !modelsRef) return
  const note = notesRef[noteId]
  if (!note) return

  const user = req.user
  if (user && user.logged_in) {
    const userId = user.id
    // Track last change user
    note.lastchangeuser = userId

    // Record author if not already tracked
    if (!note.authors[userId]) {
      modelsRef.Author.findOrCreate({
        where: { noteId, userId },
        defaults: { noteId, userId, color: note.users[req.sessionID] ? note.users[req.sessionID].color : null }
      }).spread(function (author) {
        if (author) {
          note.authors[author.userId] = {
            userid: author.userId,
            color: author.color,
            photo: user.photo,
            name: user.name
          }
        }
      }).catch(function (err) {
        logger.error('braid authorship tracking failed: ' + err)
      })
    }

    // Track temp user activity
    note.tempUsers[userId] = Date.now()
  } else {
    note.lastchangeuser = null
  }
}

/**
 * Convert a diff-match-patch diff into an OT operation array.
 * OT format: positive int = retain, string = insert, negative int = delete.
 *
 * @param {Array} diffs - diff-match-patch diff array [[0,'equal'],[-1,'deleted'],[1,'inserted']]
 * @returns {Array} OT operation array
 */
function diffToOtOperation (diffs) {
  const operation = []
  for (let i = 0; i < diffs.length; i++) {
    const [type, text] = diffs[i]
    switch (type) {
      case 0: // equal -> retain
        operation.push(text.length)
        break
      case 1: // insert -> insert string
        operation.push(text)
        break
      case -1: // delete -> negative length
        operation.push(-text.length)
        break
    }
  }
  return operation
}

/**
 * Express middleware that serves braid-text resources.
 * Mount this on the Express app: app.use('/braid', braidMiddleware)
 */
function braidMiddleware (req, res) {
  // Extract noteId from URL: /braid/:noteId -> noteId
  const noteId = req.url.split('?')[0].replace(/^\//, '')
  if (!noteId) {
    return res.status(400).send('Missing note ID')
  }

  // Check if note is loaded
  if (!loadedNotes.has(noteId)) {
    return res.status(404).send('Note not loaded')
  }

  // Enforce edit permissions on PUT requests (writes)
  if (req.method === 'PUT') {
    const note = notesRef ? notesRef[noteId] : null
    if (!checkEditPermission(req, note)) {
      logger.info('braid: user denied edit permission for note ' + noteId)
      return res.status(403).send('Permission denied')
    }
  }

  // Set content type
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')

  // For PUT requests, capture document state before serve() for per-character authorship tracking
  const oldDocPromise = (req.method === 'PUT' && notesRef && notesRef[noteId])
    ? braidText.get(noteId).then(function (doc) { return doc || '' }).catch(function () { return '' })
    : Promise.resolve(null)

  oldDocPromise.then(function (oldDoc) {
    // Delegate to braid-text's serve handler
    braidText.serve(req, res, {
      key: noteId,
      put_cb: function (key, val) {
        // Mark note as dirty when content changes
        dirtyNotes.add(key)
        // Track authorship (last-change user + author records)
        trackAuthorship(key, req)
        // Per-character authorship tracking via diff
        if (oldDoc !== null && modelsRef && notesRef && notesRef[key]) {
          setImmediate(function () {
            try {
              const newDoc = val || ''
              const diffs = dmp.diff_main(oldDoc, newDoc)
              dmp.diff_cleanupSemantic(diffs)
              const operation = diffToOtOperation(diffs)
              const userId = (req.user && req.user.logged_in) ? req.user.id : null
              const note = notesRef[key]
              if (note) {
                note.authorship = modelsRef.Note.updateAuthorshipByOperation(operation, userId, note.authorship)
              }
            } catch (err) {
              logger.error('braid: authorship tracking error: ' + err.message)
            }
          })
        }
        logger.debug('braid: note ' + key + ' modified via PUT')
      }
    })
  })
}

module.exports = {
  init,
  braidMiddleware,
  loadNote,
  getDocument,
  isDirty,
  unloadNote,
  braid_text: braidText
}
