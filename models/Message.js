import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    email: { type: String, required: true, maxlength: 120 },
    message: { type: String, required: true, maxlength: 3000 },
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model('Message', messageSchema);
