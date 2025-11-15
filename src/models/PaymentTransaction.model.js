import mongoose from 'mongoose';

const { Schema } = mongoose;

const paymentTransactionSchema = new Schema(
  {
    admissionId: {
      type: Schema.Types.ObjectId,
      ref: 'Admission',
      index: true,
    },
    joiningId: {
      type: Schema.Types.ObjectId,
      ref: 'Joining',
      required: true,
      index: true,
    },
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'Lead',
      index: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
      uppercase: true,
    },
    mode: {
      type: String,
      enum: ['cash', 'online', 'upi_qr'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
      index: true,
    },
    collectedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    cashfreeOrderId: {
      type: String,
      trim: true,
      index: true,
    },
    cashfreePaymentSessionId: {
      type: String,
      trim: true,
    },
    referenceId: {
      type: String,
      trim: true,
      index: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    isAdditionalFee: {
      type: Boolean,
      default: false,
      index: true,
    },
    meta: {
      type: Schema.Types.Mixed,
      default: {},
    },
    processedAt: {
      type: Date,
      default: Date.now,
    },
    verifiedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

paymentTransactionSchema.index({ leadId: 1, createdAt: -1 });
paymentTransactionSchema.index({ admissionId: 1, createdAt: -1 });

const PaymentTransaction = mongoose.model('PaymentTransaction', paymentTransactionSchema);

export default PaymentTransaction;



