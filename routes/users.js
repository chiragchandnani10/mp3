const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');

const asUniqueIdStrings = arr =>
    [...new Set((arr || []).filter(Boolean).map(String))];


router.get('/', async (req, res) => {
    try {
        let query = User.find(JSON.parse(req.query.where || "{}"));
        if (req.query.sort) query = query.sort(JSON.parse(req.query.sort));
        if (req.query.select) query = query.select(JSON.parse(req.query.select));
        if (req.query.skip) query = query.skip(parseInt(req.query.skip));
        if (req.query.limit) query = query.limit(parseInt(req.query.limit || "0"));
        let count = false;
        if (req.query.count) count = JSON.parse(req.query.count || false);
        const users = await query;
        if(count == true){
            const totalCount = await User.countDocuments(JSON.parse(req.query.where || "{}"));
            return res.status(200).json({ message: "OK", data: totalCount });
        }
        res.status(200).json({ message: "OK", data: users });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error", data: null });
    }
});



router.post('/', async (req, res) => {
    try {
        const { name, email } = req.body;
        if (!name || !email) {
            return res.status(400).json({ message: "Name and email are required", data: null });
        }
        let query = User.findOne({email: email});
        const userWithSameEmail = await query;
        if (userWithSameEmail) {
            return res.status(400).json({ message: "User with same email already exists", data: null });
        }
        const user = new User({ ...req.body });
        const {pendingTasks} = req.body;
        await user.save();
        if(pendingTasks){
            await Task.updateMany(
                { _id: { $in: pendingTasks } },
                { $set: { assignedUser: String(user._id), assignedUserName: user.name } }
              );
        }
        res.status(201).json({ message: "User created", data: user });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error", data: null });
    }
});


// router.post('/', async (req, res) => {
//     const session = await User.startSession();
//     try {
//       const { name, email, pendingTasks } = req.body || {};
  
//       if (!name || !email) {
//         return res.status(400).json({ message: 'Name and email are required', data: null });
//       }
//       const existing = await User.findOne({ email }).lean();
//       if (existing) {
//         return res.status(400).json({ message: 'User with same email already exists', data: null });
//       }
  
//       let tids = [];
//       if (pendingTasks !== undefined) {
//         if (!Array.isArray(pendingTasks)) {
//           return res.status(400).json({ message: 'pendingTasks must be an array of task IDs', data: null });
//         }
//         tids = [...new Set(pendingTasks.filter(Boolean).map(String))];
//       }
  
//       let createdUser;
  
//       await session.withTransaction(async () => {
//         createdUser = await User.create([ { name, email } ], { session });
//         createdUser = createdUser[0]; // array insert
  
//         if (!tids.length) return;
  
//         const tasks = await Task.find({ _id: { $in: tids } })
//           .select('_id completed assignedUser')
//           .session(session);
  
//         if (tasks.length !== tids.length) {
//           throw Object.assign(new Error('Invalid pendingTasks: one or more task IDs do not exist'), { status: 400 });
//         }
  
//         const completedOnes = tasks.filter(t => t.completed);
//         if (completedOnes.length) {
//           throw Object.assign(new Error('Invalid pendingTasks: contains completed task(s)'), { status: 400 });
//         }
  
//         await Task.updateMany(
//           { _id: { $in: tids } },
//           {
//             $set: {
//               assignedUser: String(createdUser._id),
//               assignedUserName: createdUser.name,
//               completed: false
//             }
//           },
//           { session }
//         );
  
//         const oldUserIds = [...new Set(tasks.map(t => t.assignedUser).filter(Boolean).map(String))];
//         if (oldUserIds.length) {
//           await User.updateMany(
//             { _id: { $in: oldUserIds } },
//             { $pull: { pendingTasks: { $in: tids } } },
//             { session }
//           );
//         }
  
//         await User.updateOne(
//           { _id: createdUser._id },
//           { $addToSet: { pendingTasks: { $each: tids } } },
//           { session }
//         );
//       });
  
//       const fresh = await User.findById(createdUser._id).lean();
//       return res.status(201).json({ message: 'User created', data: fresh });
//     } catch (err) {
//       console.error(err);
//       const code = err.status || 500;
//       const msg =
//         code === 400
//           ? err.message
//           : 'Server error';
//       return res.status(code).json({ message: msg, data: null });
//     } finally {
//       session.endSession();
//     }
//   });
  



router.get('/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select(JSON.parse(req.query.select || "{}"));
        if (!user) return res.status(404).json({ message: "User not found", data: null });
        res.status(200).json({ message: "OK", data: user });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error", data: null });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const updatedUser = await User.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });            
        if (!updatedUser) return res.status(404).json({ message: "User not found", data: null });
        await Task.updateMany(
            { _id: { $in: req.body.pendingTasks } },
            { $set: { assignedUser: String(updatedUser._id), assignedUserName: updatedUser.name } }
          );
            
        res.status(200).json({ message: "User updated", data: updatedUser });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error", data: null });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found", data: null });
        
        await Task.updateMany({ assignedUser: req.params.id }, { assignedUser: "", assignedUserName: "unassigned" });
        res.status(204).json({ message: "User deleted", data: user });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Server error", data: null });
    }
});

module.exports = router;
