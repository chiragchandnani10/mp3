
const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const User = require('../models/User');


function toBool(v, fallback = false) {
  if (v === true || v === false) return v;
  if (v === 1 || v === '1') return true;
  if (v === 0 || v === '0') return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === 'no' || s === 'off') return false;
  }
  return fallback;
}


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


async function syncPendingTasks({ task, addForUserId, removeFromUserIds = [] }) {
  const tid = String(task._id);

  const toRemove = [...new Set((removeFromUserIds || []).filter(Boolean).map(String))];
  if (toRemove.length) {
    await User.updateMany(
      { _id: { $in: toRemove } },
      { $pull: { pendingTasks: tid } }
    );
  }

  if (addForUserId && !task.completed) {
    await User.updateOne(
      { _id: String(addForUserId) },
      { $addToSet: { pendingTasks: tid } }
    );
  }
}


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
      completed: toBool(req.body.completed, false),
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
      completed: toBool(req.body.completed, false),
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
