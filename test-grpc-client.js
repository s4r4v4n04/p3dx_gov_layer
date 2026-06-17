/**
 * gRPC Client Test Script
 * 
 * This script demonstrates how to create a gRPC client to communicate
 * with the Governance Layer gRPC server.
 * 
 * This can be used to:
 * 1. Test the gRPC server functionality
 * 2. Serve as a template for integrating gRPC into other services (e.g., AAA backend)
 * 
 * Usage:
 *   node test-grpc-client.js
 */

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

/**
 * Load the .proto file and create the gRPC client
 * 
 * This is the same process used in the server, but now we're creating a client
 * instead of a server.
 */
const PROTO_PATH = path.join(__dirname, 'protos/governance.proto');

// Load the .proto file
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

// Load the package definition into gRPC
const governanceProto = grpc.loadPackageDefinition(packageDefinition).governance;

/**
 * Create the gRPC client
 * 
 * The client connects to the gRPC server running on localhost:50052
 * We use insecure credentials for development (no SSL/TLS)
 */
const GRPC_SERVER_URL = 'localhost:50052';
const client = new governanceProto.GovernanceService(
  GRPC_SERVER_URL,
  grpc.credentials.createInsecure()
);

console.log('[gRPC Client] Connected to server at', GRPC_SERVER_URL);

/**
 * Test 1: Submit a Form
 * 
 * This demonstrates how to submit a form using gRPC
 */
function testSubmitForm() {
  console.log('\n=== Test 1: Submit Form ===');
  
  // Create the form submission object
  // Note: Field names must match the .proto definition (camelCase)
  const formData = {
    formId: 'outputform-001',
    requestedBy: 'test-user',
    outputOwnerId: 'test-output-owner',
    numServerRounds: 10,
    fractionEvaluate: 0.5,
    localEpochs: 1,
    learningRate: 0.01,
    batchSize: 32,
    model: 'AlexNet',
    framework: 'flwrlabs',
    components: {
      'param1': 'value1',
      'param2': 'value2'
    },
    filled: true,
    requestedAt: new Date().toISOString(),
    filledAt: new Date().toISOString()
  };
  
  // Call the SubmitForm RPC method
  // gRPC calls are asynchronous, so we use a callback
  client.SubmitForm(formData, (error, response) => {
    if (error) {
      console.error('[gRPC Client] Error submitting form:', error.message);
      return;
    }
    
    console.log('[gRPC Client] Form submitted successfully!');
    console.log('[gRPC Client] Response:', response);
    
    // Test 2: Get the form we just submitted
    if (response.submissionId) {
      testGetForm(response.submissionId);
    }
  });
}

/**
 * Test 2: Get a Form by ID
 * 
 * This demonstrates how to retrieve a specific form using gRPC
 */
function testGetForm(formId) {
  console.log('\n=== Test 2: Get Form ===');
  
  // Create the request object with the form ID
  const request = {
    id: formId
  };
  
  // Call the GetForm RPC method
  client.GetForm(request, (error, response) => {
    if (error) {
      console.error('[gRPC Client] Error getting form:', error.message);
      return;
    }
    
    console.log('[gRPC Client] Form retrieved successfully!');
    console.log('[gRPC Client] Form data:', JSON.stringify(response, null, 2));
    
    // Test 3: Get all forms
    testGetAllForms();
  });
}

/**
 * Test 3: Get All Forms
 * 
 * This demonstrates how to retrieve all forms using gRPC
 */
function testGetAllForms() {
  console.log('\n=== Test 3: Get All Forms ===');
  
  // Create an empty request object
  const request = {};
  
  // Call the GetAllForms RPC method
  client.GetAllForms(request, (error, response) => {
    if (error) {
      console.error('[gRPC Client] Error getting all forms:', error.message);
      return;
    }
    
    console.log('[gRPC Client] All forms retrieved successfully!');
    console.log('[gRPC Client] Total count:', response.totalCount);
    console.log('[gRPC Client] Forms:', response.forms);
    
    // Test 4: Delete a form (if there are any)
    if (response.forms && response.forms.length > 0) {
      testDeleteForm(response.forms[0].id);
    } else {
      console.log('[gRPC Client] No forms to delete, skipping delete test');
    }
  });
}

/**
 * Test 4: Delete a Form
 * 
 * This demonstrates how to delete a form using gRPC
 */
function testDeleteForm(formId) {
  console.log('\n=== Test 4: Delete Form ===');
  
  // Create the request object with the form ID
  const request = {
    id: formId
  };
  
  // Call the DeleteForm RPC method
  client.DeleteForm(request, (error, response) => {
    if (error) {
      console.error('[gRPC Client] Error deleting form:', error.message);
      return;
    }
    
    console.log('[gRPC Client] Form deleted successfully!');
    console.log('[gRPC Client] Response:', response);
    
    console.log('\n=== All Tests Completed ===');
    
    // Close the client connection
    client.close();
    console.log('[gRPC Client] Client connection closed');
  });
}

/**
 * Run the tests
 * 
 * Start with the SubmitForm test, which will trigger the other tests
 */
console.log('[gRPC Client] Starting gRPC client tests...');
testSubmitForm();

/**
 * Integration Example: How to use this in another service (e.g., AAA backend)
 * 
 * Below is an example of how you would integrate this gRPC client into the AAA backend
 * to replace the REST API call to the governance layer.
 * 
 * 
 * // In AAA backend (e.g., src/grpc/governance.client.js):
 * 
 * const grpc = require('@grpc/grpc-js');
 * const protoLoader = require('@grpc/proto-loader');
 * const path = require('path');
 * 
 * const PROTO_PATH = path.join(__dirname, '../../protos/governance.proto');
 * const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
 *   keepCase: true,
 *   longs: String,
 *   enums: String,
 *   defaults: true,
 *   oneofs: true
 * });
 * 
 * const governanceProto = grpc.loadPackageDefinition(packageDefinition).governance;
 * const GOVERNANCE_GRPC_URL = 'localhost:50052';
 * 
 * const governanceClient = new governanceProto.GovernanceService(
 *   GOVERNANCE_GRPC_URL,
 *   grpc.credentials.createInsecure()
 * );
 * 
 * // Function to submit form to governance layer via gRPC
 * async function submitFormToGovernance(formData) {
 *   return new Promise((resolve, reject) => {
 *     governanceClient.SubmitForm(formData, (error, response) => {
 *       if (error) {
 *         reject(error);
 *       } else {
 *         resolve(response);
 *       }
 *     });
 *   });
 * }
 * 
 * // Usage in AAA backend routes:
 * // Instead of:
 * // const governanceRes = await fetch('http://localhost:8083/api/v1/form-submissions', { ... });
 * 
 * // Use:
 * // const governanceRes = await submitFormToGovernance({
 * //   formId: 'outputform-001',
 * //   requestedBy: formData.requested_by,
 * //   outputOwnerId: formData.output_owner_id,
 * //   // ... other fields
 * // });
 */
