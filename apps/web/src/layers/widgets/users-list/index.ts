// Public API for the `users-list` widget (FSD widgets layer, ADR-0005 §3, §4.1): a
// client island that reads `GET /api/users` and refetches when the `user-create`
// feature invalidates the users query key.
export { UsersList } from './ui/UsersList';
