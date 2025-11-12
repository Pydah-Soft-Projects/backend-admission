import axios from 'axios';

const API_VERSION = '2023-08-01';

const getBaseUrl = (environment = 'sandbox') => {
  return environment === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
};

const getHeaders = (clientId, clientSecret) => ({
  'x-client-id': clientId,
  'x-client-secret': clientSecret,
  'x-api-version': API_VERSION,
  'Content-Type': 'application/json',
});

export const createOrder = async ({ environment, clientId, clientSecret, payload }) => {
  const baseUrl = getBaseUrl(environment);

  try {
    const response = await axios.post(`${baseUrl}/orders`, payload, {
      headers: getHeaders(clientId, clientSecret),
      timeout: 15000,
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(
        error.response.data?.message ||
          error.response.data?.error?.message ||
          'Cashfree order creation failed'
      );
    }
    throw error;
  }
};

export const getOrder = async ({ environment, clientId, clientSecret, orderId }) => {
  const baseUrl = getBaseUrl(environment);
  try {
    const response = await axios.get(`${baseUrl}/orders/${orderId}`, {
      headers: getHeaders(clientId, clientSecret),
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(
        error.response.data?.message ||
          error.response.data?.error?.message ||
          'Cashfree order lookup failed'
      );
    }
    throw error;
  }
};



