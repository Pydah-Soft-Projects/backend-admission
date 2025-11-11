import mongoose from 'mongoose';
import {
  encryptSensitiveValue,
  decryptSensitiveValue,
} from '../utils/encryption.util.js';

const { Schema } = mongoose;

const paymentGatewayConfigSchema = new Schema(
  {
    provider: {
      type: String,
      enum: ['cashfree'],
      required: true,
      index: true,
    },
    displayName: {
      type: String,
      default: 'Cashfree',
      trim: true,
    },
    clientId: {
      type: String,
      required: true,
      trim: true,
      set: encryptSensitiveValue,
      get: decryptSensitiveValue,
    },
    clientSecret: {
      type: String,
      required: true,
      trim: true,
      set: encryptSensitiveValue,
      get: decryptSensitiveValue,
    },
    environment: {
      type: String,
      enum: ['sandbox', 'production'],
      default: 'sandbox',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

paymentGatewayConfigSchema.index({ provider: 1 }, { unique: true });

const PaymentGatewayConfig = mongoose.model('PaymentGatewayConfig', paymentGatewayConfigSchema);

export default PaymentGatewayConfig;


