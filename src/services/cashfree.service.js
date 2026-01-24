import axios from 'axios';

const API_VERSION = '2023-08-01';

const getBaseUrl = (environment = 'sandbox') => {
  return environment === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
};

const getHeaders = (clientId, clientSecret) => {
  // Ensure credentials are trimmed and have no extra whitespace
  const cleanClientId = (clientId || '').trim();
  const cleanClientSecret = (clientSecret || '').trim();
  
  return {
    'x-client-id': cleanClientId,
    'x-client-secret': cleanClientSecret,
    'x-api-version': API_VERSION,
    'Content-Type': 'application/json',
  };
};

export const createOrder = async ({ environment, clientId, clientSecret, payload }) => {
  const baseUrl = getBaseUrl(environment);

  // Trim and validate credentials
  const trimmedClientId = (clientId || '').trim();
  const trimmedClientSecret = (clientSecret || '').trim();

  if (!trimmedClientId || !trimmedClientSecret) {
    throw new Error('Cashfree credentials are missing or empty');
  }

  try {
    const response = await axios.post(`${baseUrl}/orders`, payload, {
      headers: getHeaders(trimmedClientId, trimmedClientSecret),
      timeout: 15000,
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      const errorData = error.response.data;
      const errorMessage = errorData?.message || 
                          errorData?.error?.message || 
                          errorData?.error || 
                          'Cashfree order creation failed';
      
      // Log full error details for debugging
      console.error('Cashfree API Error Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        errorData: errorData,
        url: `${baseUrl}/orders`,
        environment,
      });
      
      throw new Error(errorMessage);
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



