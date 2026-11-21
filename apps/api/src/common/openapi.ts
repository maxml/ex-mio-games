export const messageOpenApiSchema = {
  type: 'object',
  required: ['message'],
  properties: {
    message: { type: 'string' },
  },
};

export const validationErrorOpenApiSchema = {
  type: 'object',
  required: ['message', 'issues'],
  properties: {
    message: { type: 'string' },
    issues: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
  },
};

export const dependencyHealthOpenApiSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
    latencyMs: { type: 'number', minimum: 0 },
    error: { type: 'string' },
  },
};

export const healthCheckOpenApiSchema = {
  type: 'object',
  required: ['status', 'uptime', 'version', 'checks'],
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded', 'down'] },
    uptime: { type: 'number', minimum: 0 },
    version: { type: 'string' },
    checks: {
      type: 'object',
      additionalProperties: dependencyHealthOpenApiSchema,
    },
  },
};

export const userOpenApiSchema = {
  type: 'object',
  required: ['id', 'email', 'name', 'createdAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

export const createUserInputOpenApiSchema = {
  type: 'object',
  required: ['email'],
  properties: {
    email: { type: 'string', format: 'email' },
    name: { type: 'string', minLength: 1, maxLength: 100 },
  },
};

export const authUserOpenApiSchema = {
  type: 'object',
  required: ['id', 'email', 'provider'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    provider: { type: 'string' },
  },
};

export const authSessionOpenApiSchema = {
  type: 'object',
  required: ['token', 'user', 'expiresAt'],
  properties: {
    token: { type: 'string' },
    user: authUserOpenApiSchema,
    expiresAt: { type: 'string', format: 'date-time' },
  },
};

export const passwordRegisterInputOpenApiSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 8 },
    name: { type: 'string', minLength: 1, maxLength: 100 },
  },
};

export const passwordLoginInputOpenApiSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
  },
};
