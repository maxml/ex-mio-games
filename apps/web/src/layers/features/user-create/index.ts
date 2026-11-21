// Public API for the `user-create` feature (FSD features layer, ADR-0005 §4.2): a
// react-hook-form + Zod reference form that creates a user against the real
// baseline `POST /api/users`. Consumed by the `views` layer as a client island.
export { CreateUserForm } from './ui/CreateUserForm';
