
// routes/tasks.js
const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');

/* ----------------------- helpers ----------------------- */

const PARSE_ERR = Symbol('PARSE_ERR');

function safeJsonParse(str, fallback) {
  if (str == null) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return PARSE_ERR;
  }
}

function ok(res, data) {
  return res.status(200).json({ message: 'OK', data });
}

function created(res, data) {
  return res.status(201).json({ message: 'Task created', data });
}

function noContent(res) {
  return res.status(204).json({ message: 'No content', data: null });
}

function badRequest(res, msg) {
  return res.status(400).json({ message: msg || 'Bad request', data: null });
}

function notFound(res, what = 'Task') {
  return res.status(404).json({ message: `${what} not found`, data: null });
}

function serverError(res, err) {
  console.error(err);
  return res.status(500).json({ message: 'Server error', data: null });
}

/**
 * Maintain User.pendingTasks (strings) for a given task.
 * - Add task id if assignedUser is set and task is NOT completed
 * - Remove task id from any user ids provided
 */
async function syncPendingTasks({ task, addForUserId, removeFromUserIds = [] }) {
  const tid = String(task._id);

  // Remove from provided users (unique list, skip falsy)
  const toRemove = [...new Set((removeFromUserIds || []).filter(Boolean).map(String))];
  if (toRemove.length) {
    await User.updateMany(
      { _id: { $in: toRemove } },
      { $pull: { pendingTasks: tid } }
    );
  }

  // Add to assigned user if applicable (only when not completed)
  if (addForUserId && !task.completed) {
    await User.updateOne(
      { _id: String(addForUserId) },
      { $addToSet: { pendingTasks: tid } }
    );
  }
}

/* ----------------------- GET /tasks ----------------------- */
/**
 * Supports JSON-encoded: where, sort, select, skip, limit, count
 * limit defaults to 100 for tasks
 */
router.get('/', async (req, res) => {
  try {
    const where  = safeJsonParse(req.query.where, {});
    const sort   = safeJsonParse(req.query.sort, null);
    const select = safeJsonParse(req.query.select, null);
    const count  = safeJsonParse(req.query.count, false);

    if ([where, sort, select, count].includes(PARSE_ERR)) {
      return badRequest(res, 'Invalid JSON in query parameters');
    }

    // If only a count is requested, short-circuit for performance
    if (count === true) {
      const total = await Task.countDocuments(where || {});
      return ok(res, total);
    }

    const q = Task.find(where || {});
    if (sort)   q.sort(sort);
    if (select) q.select(select);

    // pagination
    const rawSkip  = req.query.skip;
    const rawLimit = req.query.limit;

    const skip  = rawSkip  !== undefined ? Math.max(0, parseInt(rawSkip, 10)  || 0) : 0;
    const limit = rawLimit !== undefined ? Math.max(1, parseInt(rawLimit, 10) || 100) : 100;

    q.skip(skip).limit(limit);

    const tasks = await q;
    return ok(res, tasks);
  } catch (err) {
    return serverError(res, err);
  }
});

/* ----------------------- POST /tasks ----------------------- */
/**
 * Create a new task. Requires name and deadline.
 * Keeps User.pendingTasks in sync (adds task id if assigned and not completed).
 */
router.post('/', async (req, res) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) {
      return badRequest(res, 'Name and deadline are required');
    }

    // Start with safe defaults per schema
    let {
      description = '',
      completed = false,
      assignedUser = '',
      assignedUserName = 'unassigned'
    } = req.body;

    // If an assignedUser is provided, validate it exists and fetch its name
    if (assignedUser && typeof assignedUser === 'string') {
      const user = await User.findById(assignedUser).select('name');
      if (!user) {
        return badRequest(res, 'assignedUser not found');
      }
      assignedUserName = user.name;
    } else {
      // Normalize falsy
      assignedUser = '';
      assignedUserName = 'unassigned';
    }

    const task = await Task.create({
      name,
      description,
      deadline,
      completed: !!completed,
      assignedUser,
      assignedUserName
      // dateCreated should be auto by schema
    });

    // Maintain user's pendingTasks (pending only)
    if (assignedUser) {
      await syncPendingTasks({ task, addForUserId: assignedUser });
    }

    return created(res, task);
  } catch (err) {
    return serverError(res, err);
  }
});

/* ----------------------- GET /tasks/:id ----------------------- */
/**
 * Supports JSON-encoded `select`
 */
router.get('/:id', async (req, res) => {
  try {
    const select = safeJsonParse(req.query.select, null);
    if (select === PARSE_ERR) {
      return badRequest(res, 'Invalid JSON in select');
    }

    const q = Task.findById(req.params.id);
    if (select) q.select(select);

    const task = await q;
    if (!task) return notFound(res, 'Task');

    return ok(res, task);
  } catch (err) {
    return serverError(res, err);
  }
});

/* ----------------------- PUT /tasks/:id ----------------------- */
/**
 * Replace an entire task (PUT semantics).
 * Requires name and deadline. Recomputes assignedUserName if assignedUser present.
 * Keeps User.pendingTasks in sync:
 *  - remove from previous user's list
 *  - add to new user's list if assigned & not completed
 *  - if completed=true, ensure it is NOT in pendingTasks
 */
router.put('/:id', async (req, res) => {
  try {
    const { name, deadline } = req.body || {};
    if (!name || !deadline) {
      return badRequest(res, 'Name and deadline are required');
    }

    // Load previous task for relationship maintenance
    const prev = await Task.findById(req.params.id);
    if (!prev) return notFound(res, 'Task');

    let {
      description = '',
      completed = false,
      assignedUser = '',
      assignedUserName = 'unassigned'
    } = req.body;

    // If assigned, verify user and set name; otherwise normalize to unassigned
    if (assignedUser && typeof assignedUser === 'string') {
      const user = await User.findById(assignedUser).select('name');
      if (!user) return badRequest(res, 'assignedUser not found');
      assignedUserName = user.name;
    } else {
      assignedUser = '';
      assignedUserName = 'unassigned';
    }

    // Build full replacement; keep original dateCreated
    const replacement = {
      name,
      description,
      deadline,
      completed: !!completed,
      assignedUser,
      assignedUserName,
      dateCreated: prev.dateCreated
    };

    const updated = await Task.findByIdAndUpdate(
      req.params.id,
      replacement,
      { new: true, overwrite: true, runValidators: true }
    );

    // Sync user.pendingTasks
    const prevUserId = prev.assignedUser || '';
    const nextUserId = updated.assignedUser || '';

    const removeFrom = [];
    if (prevUserId) removeFrom.push(prevUserId);
    // If user changed, make sure we also remove from prev (handled above)
    // If completed, also ensure it is removed from whoever is assigned now
    if (updated.completed && nextUserId) removeFrom.push(nextUserId);

    await syncPendingTasks({
      task: updated,
      addForUserId: !updated.completed && nextUserId ? nextUserId : null,
      removeFromUserIds: removeFrom
    });

    return ok(res, updated);
  } catch (err) {
    return serverError(res, err);
  }
});

/* ----------------------- DELETE /tasks/:id ----------------------- */
/**
 * Delete task. Also remove it from its assigned user's pendingTasks.
 */
router.delete('/:id', async (req, res) => {
    try {
      const deleted = await Task.findByIdAndDelete(req.params.id);
      if (!deleted) return notFound(res, 'Task');
  
      if (deleted.assignedUser) {
        await User.updateOne(
          { _id: String(deleted.assignedUser) },
          { $pull: { pendingTasks: String(deleted._id) } }
        );
      }
  
      // ✅ Return 204 No Content with *no* body
      return res.status(204).end();
    } catch (err) {
      return serverError(res, err);
    }
  });
  

module.exports = router;
