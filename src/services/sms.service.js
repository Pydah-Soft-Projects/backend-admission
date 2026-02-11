import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BULKSMS_API_KEY = process.env.BULKSMS_API_KEY;
const BULKSMS_SENDER_ID = process.env.BULKSMS_SENDER_ID || 'PYDAHK';

const smsService = {
  /**
   * Send OTP to a mobile number
   * @param {string} mobileNumber - The 10-digit mobile number
   * @param {string} otp - The OTP code
   * @returns {Promise<Object>} - The API response
   */
  sendOTP: async (mobileNumber, otp) => {
    if (!BULKSMS_API_KEY) {
      console.warn('BULKSMS_API_KEY is not set. OTP sending skipped (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    // Clean mobile number (keep last 10 digits if needed, or assume valid input)
    // The API expects a specific format, usually just the number.
    const cleanNumber = mobileNumber.replace(/\D/g, '').slice(-10);
    const otpTemplateId = process.env.OTP_TEMPLATE_ID || '1007482811215703964'; // Fallback or Env

    const message = `Your OTP for recovering your password is ${otp} - PYDAH`;
    // URL Encode message
    const encodedMessage = encodeURIComponent(message);

    const url = `https://www.bulksmsapps.com/api/apismsv2.aspx?apikey=${BULKSMS_API_KEY}&sender=${BULKSMS_SENDER_ID}&mobile=${cleanNumber}&message=${encodedMessage}&type=1&tempid=${otpTemplateId}`;

    try {
      const response = await axios.get(url);
      console.log(`SMS Sent to ${cleanNumber}. Response:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Failed to send SMS:', error.message);
      throw new Error('Failed to send OTP SMS');
    }
  },

  /**
   * Send Password Reset Success SMS
   * Template: Hello {#var#} your password has been updated. Username: {#var#} New Password: {#var#} Login: {#var#}- Pydah College
   * Template ID: 1707176526611076697
   */
  sendPasswordResetSuccess: async (mobileNumber, name, username, newPassword, loginUrl) => {
    if (!BULKSMS_API_KEY) {
      console.warn('BULKSMS_API_KEY is not set. Reset SMS skipping (Dev Mode).');
      return { success: true, message: 'SMS simulation successful (Dev Mode)' };
    }

    const cleanNumber = mobileNumber.replace(/\D/g, '').slice(-10);
    
    // Construct message: "Hello {name} your password has been updated. Username: {username} New Password: {newPassword} Login: {loginUrl}- Pydah College"
    const message = `Hello ${name} your password has been updated. Username: ${username} New Password: ${newPassword} Login: ${loginUrl}- Pydah College`;
    
    // URL Encode message
    const encodedMessage = encodeURIComponent(message);
    const templateId = '1707176526611076697';

    const url = `https://www.bulksmsapps.com/api/apismsv2.aspx?apikey=${BULKSMS_API_KEY}&sender=${BULKSMS_SENDER_ID}&mobile=${cleanNumber}&message=${encodedMessage}&type=1&tempid=${templateId}`;

    try {
      const response = await axios.get(url);
      console.log(`Password Reset SMS Sent to ${cleanNumber}. Response:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error('Failed to send Password Reset SMS:', error.message);
      // Don't throw here, as password is already reset. Just log error.
      return { success: false, error: error.message }; 
    }
  },
};

export default smsService;
