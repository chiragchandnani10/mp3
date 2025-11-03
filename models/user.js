var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema({
    name: { type: String },
    email: { type: String },
    pendingTasks: { type: [String] } ,
    dateCreated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);