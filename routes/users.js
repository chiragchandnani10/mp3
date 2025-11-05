const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');


const asUniqueIdStrings = (arr = []) =>
  [...new Set(arr.filter(Boolean).map(String))];

const parseJSON = (str, fallback = {}) => {
  try {
    return JSON.parse(str || '{}');
  } catch {
    return fallback;
  }
};

router.get('/', async (req, res) => {
  try {
    const where = parseJSON(req.query.where);
    const sort = parseJSON(req.query.sort);
    const select = parseJSON(req.query.select);
    const skip = parseInt(req.query.skip || '0', 10);
    const limit = parseInt(req.query.limit || '0', 10);
    const count = JSON.parse(req.query.count || 'false');

    let query = User.find(where);
    if (sort) query = query.sort(sort);
    if (select) query = query.select(select);
    if (skip) query = query.skip(skip);
    if (limit) query = query.limit(limit);

    if (count) {
      const totalCount = await User.countDocuments(where);
      return res.status(200).json({ message: 'OK', data: totalCount });
    }

    const users = await query;
    return res.status(200).json({ message: 'OK', data: users });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', data: null });
  }
});


router.post('/', async (req, res) => {
  const session = await User.startSession();

  try {
    const { name, email, pendingTasks } = req.body || {};

    if (!name || !email) {
      return res.status(400).json({ message: 'Name and email are required', data: null });
    }

    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      return res.status(400).json({ message: 'User with same email already exists', data: null });
    }

    const tids = pendingTasks
      ? asUniqueIdStrings(pendingTasks)
      : [];

    let createdUser;

    await session.withTransaction(async () => {
      [createdUser] = await User.create([{ name, email }], { session });

      if (!tids.length) return;

      const tasks = await Task.find({ _id: { $in: tids } })
        .select('_id completed assignedUser')
        .session(session);

      if (tasks.length !== tids.length) {
        throw Object.assign(new Error('Invalid pendingTasks: one or more task IDs do not exist'), { status: 400 });
      }

      if (tasks.some(t => t.completed)) {
        throw Object.assign(new Error('Invalid pendingTasks: contains completed task(s)'), { status: 400 });
      }

      await Task.updateMany(
        { _id: { $in: tids } },
        {
          $set: {
            assignedUser: String(createdUser._id),
            assignedUserName: createdUser.name,
            completed: false
          }
        },
        { session }
      );

      const oldUserIds = asUniqueIdStrings(tasks.map(t => t.assignedUser));
      if (oldUserIds.length) {
        await User.updateMany(
          { _id: { $in: oldUserIds } },
          { $pull: { pendingTasks: { $in: tids } } },
          { session }
        );
      }

      await User.updateOne(
        { _id: createdUser._id },
        { $addToSet: { pendingTasks: { $each: tids } } },
        { session }
      );
    });

    const freshUser = await User.findById(createdUser._id).lean();
    return res.status(201).json({ message: 'User created', data: freshUser });
  } catch (error) {
    console.error(error);
    const code = error.status || 500;
    const message = code === 400 ? error.message : 'Server error';
    return res.status(code).json({ message, data: null });
  } finally {
    session.endSession();
  }
});


router.get('/:id', async (req, res) => {
  try {
    const select = parseJSON(req.query.select);
    const user = await User.findById(req.params.id).select(select);

    if (!user) {
      return res.status(404).json({ message: 'User not found', data: null });
    }

    res.status(200).json({ message: 'OK', data: user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', data: null });
  }
});


router.put('/:id', async (req, res) => {
  try {
    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found', data: null });
    }

    const tids = asUniqueIdStrings(req.body.pendingTasks || []);
    if (tids.length) {
      await Task.updateMany(
        { _id: { $in: tids } },
        {
          $set: {
            assignedUser: String(updatedUser._id),
            assignedUserName: updatedUser.name
          }
        }
      );
    }

    res.status(200).json({ message: 'User updated', data: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', data: null });
  }
});


router.delete('/:id', async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) {
      return res.status(404).json({ message: 'User not found', data: null });
    }

    await Task.updateMany(
      { assignedUser: req.params.id },
      { assignedUser: '', assignedUserName: 'unassigned' }
    );

    res.status(204).json({ message: 'User deleted', data: deletedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', data: null });
  }
});

module.exports = router;
