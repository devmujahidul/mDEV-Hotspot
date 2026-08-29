import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'invalid email'],
    },
    passwordHash: { type: String, required: true },
    displayName:  { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

userSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
