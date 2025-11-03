const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Task = require('../models/Task');


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
