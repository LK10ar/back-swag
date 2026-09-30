import mongoose from 'mongoose';

// Un seul document (key: 'site') qui contient les réglages du site : header, à propos, carrousel, contact
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

export default mongoose.model('Setting', settingSchema);
