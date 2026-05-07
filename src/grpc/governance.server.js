// Import gRPC libraries
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Import the database service to interact with PostgreSQL
import { storeFormSubmission, getAllFormSubmissions, getFormSubmissionById, deleteFormSubmission } from '../services/database.service.js';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * GovernanceServer Class
 * 
 * This class implements the gRPC service methods defined in governance.proto
 * Each method corresponds to an RPC call that can be made by gRPC clients
 */
class GovernanceServer {
  constructor(pool) {
    // Store the database pool for use in all methods
    this.pool = pool;
  }

  /**
   * SubmitForm RPC Method
   * 
   * This method handles the SubmitForm RPC call
   * It receives a FormSubmission message and stores it in the database
   * 
   * @param {Object} call - The gRPC call object containing the request
   * @param {Object} call.request - The FormSubmission message from the client
   * @param {Function} callback - The callback to send the response back to the client
   */
  async submitForm(call, callback) {
    try {
      console.log('[gRPC] SubmitForm called with:', call.request);
      
      // Extract the form data from the gRPC request
      const formData = call.request;
      
      // Convert the gRPC message to a plain object for database storage
      // The database service expects a plain JavaScript object
      const submissionData = {
        form_id: formData.formId,
        requested_by: formData.requestedBy,
        output_owner_id: formData.outputOwnerId,
        num_server_rounds: formData.numServerRounds,
        fraction_evaluate: formData.fractionEvaluate,
        local_epochs: formData.localEpochs,
        learning_rate: formData.learningRate,
        batch_size: formData.batchSize,
        model: formData.model,
        framework: formData.framework,
        components: formData.components, // This is already a map/object
        filled: formData.filled,
        requested_at: formData.requestedAt,
        filled_at: formData.filledAt
      };
      
      // Store the form submission in the database using the existing database service
      const submissionId = await storeFormSubmission(this.pool, submissionData);
      
      console.log('[gRPC] Form stored successfully with ID:', submissionId);
      
      // Send success response back to the gRPC client
      // The callback takes two arguments: (error, response)
      // If error is null, it's a success
      callback(null, {
        success: true,
        message: 'Form submitted successfully',
        submissionId: submissionId
      });
    } catch (error) {
      console.error('[gRPC] Error in SubmitForm:', error);
      
      // Send error response back to the gRPC client
      // The first argument is the error object
      callback(error, null);
    }
  }

  /**
   * GetForm RPC Method
   * 
   * This method handles the GetForm RPC call
   * It retrieves a specific form submission by ID
   * 
   * @param {Object} call - The gRPC call object
   * @param {Object} call.request - The GetFormRequest message containing the ID
   * @param {Function} callback - The callback to send the response
   */
  async getForm(call, callback) {
    try {
      console.log('[gRPC] GetForm called with ID:', call.request.id);
      
      // Extract the ID from the request
      const { id } = call.request;
      
      // Retrieve the form from the database
      const form = await getFormSubmissionById(this.pool, id);
      
      if (!form) {
        // If form not found, return an error
        const error = new Error('Form not found');
        error.code = grpc.status.NOT_FOUND;
        callback(error, null);
        return;
      }
      
      console.log('[gRPC] Form retrieved successfully');
      
      // Convert the database result to gRPC message format
      // Note: gRPC uses camelCase for field names (e.g., formId instead of form_id)
      const grpcForm = {
        id: form.id,
        formId: form.form_id,
        requestedBy: form.requested_by,
        outputOwnerId: form.output_owner_id,
        numServerRounds: form.num_server_rounds,
        fractionEvaluate: form.fraction_evaluate,
        localEpochs: form.local_epochs,
        learningRate: form.learning_rate,
        batchSize: form.batch_size,
        model: form.model,
        framework: form.framework,
        components: form.components,
        filled: form.filled,
        requestedAt: form.requested_at,
        filledAt: form.filled_at,
        createdAt: form.created_at,
        updatedAt: form.updated_at
      };
      
      // Send the form data back to the client
      callback(null, grpcForm);
    } catch (error) {
      console.error('[gRPC] Error in GetForm:', error);
      callback(error, null);
    }
  }

  /**
   * GetAllForms RPC Method
   * 
   * This method handles the GetAllForms RPC call
   * It retrieves all form submissions from the database
   * 
   * @param {Object} call - The gRPC call object
   * @param {Object} call.request - The GetAllFormsRequest message (empty for now)
   * @param {Function} callback - The callback to send the response
   */
  async getAllForms(call, callback) {
    try {
      console.log('[gRPC] GetAllForms called');
      
      // Retrieve all forms from the database
      const forms = await getAllFormSubmissions(this.pool);
      
      console.log('[gRPC] Retrieved', forms.length, 'forms');
      
      // Convert each form to gRPC message format
      const grpcForms = forms.map(form => ({
        id: form.id,
        formId: form.form_id,
        requestedBy: form.requested_by,
        outputOwnerId: form.output_owner_id,
        numServerRounds: form.num_server_rounds,
        fractionEvaluate: form.fraction_evaluate,
        localEpochs: form.local_epochs,
        learningRate: form.learning_rate,
        batchSize: form.batch_size,
        model: form.model,
        framework: form.framework,
        components: form.components,
        filled: form.filled,
        requestedAt: form.requested_at,
        filledAt: form.filled_at,
        createdAt: form.created_at,
        updatedAt: form.updated_at
      }));
      
      // Send the list of forms back to the client
      callback(null, {
        forms: grpcForms,
        totalCount: forms.length
      });
    } catch (error) {
      console.error('[gRPC] Error in GetAllForms:', error);
      callback(error, null);
    }
  }

  /**
   * DeleteForm RPC Method
   * 
   * This method handles the DeleteForm RPC call
   * It deletes a specific form submission by ID
   * 
   * @param {Object} call - The gRPC call object
   * @param {Object} call.request - The DeleteFormRequest message containing the ID
   * @param {Function} callback - The callback to send the response
   */
  async deleteForm(call, callback) {
    try {
      console.log('[gRPC] DeleteForm called with ID:', call.request.id);
      
      // Extract the ID from the request
      const { id } = call.request;
      
      // Delete the form from the database
      await deleteFormSubmission(this.pool, id);
      
      console.log('[gRPC] Form deleted successfully');
      
      // Send success response back to the client
      callback(null, {
        success: true,
        message: 'Form deleted successfully'
      });
    } catch (error) {
      console.error('[gRPC] Error in DeleteForm:', error);
      callback(error, null);
    }
  }
}

/**
 * Start the gRPC Server
 * 
 * This function initializes and starts the gRPC server
 * It loads the .proto file, creates the server, and binds it to a port
 * 
 * @param {Object} db - The database instance
 * @param {number} port - The port to listen on (default: 50051)
 * @returns {Object} The gRPC server instance
 */
function startGrpcServer(db, port = 50051) {
  // Load the .proto file
  // protoLoader.loadSync reads the .proto file and converts it to a JavaScript object
  const PROTO_PATH = path.join(__dirname, '../../protos/governance.proto');
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,  // Keep field names as they are in .proto (camelCase)
    longs: String,   // Convert 64-bit integers to strings
    enums: String,    // Convert enums to strings
    defaults: true,   // Include default values for optional fields
    oneofs: true      // Include oneof fields
  });
  
  // Load the package definition into gRPC
  // This creates the service definition from the .proto file
  const governanceProto = grpc.loadPackageDefinition(packageDefinition).governance;
  
  // Create a new gRPC server instance
  const server = new grpc.Server();
  
  // Create an instance of our GovernanceServer class
  const governanceService = new GovernanceServer(db);
  
  // Add the GovernanceService to the server
  // This maps the RPC methods defined in .proto to our class methods
  server.addService(governanceProto.GovernanceService.service, {
    SubmitForm: governanceService.submitForm.bind(governanceService),
    GetForm: governanceService.getForm.bind(governanceService),
    GetAllForms: governanceService.getAllForms.bind(governanceService),
    DeleteForm: governanceService.deleteForm.bind(governanceService),
  });
  
  // Bind the server to a port and start listening
  // We use insecure credentials for development (no SSL/TLS)
  // In production, you should use SSL credentials
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (error, boundPort) => {
      if (error) {
        console.error('[gRPC] Failed to start server:', error);
        return;
      }
      console.log(`[gRPC] Server running on port ${boundPort}`);
    }
  );
  
  return server;
}

// Export the function so it can be used in server.js
export { startGrpcServer };
