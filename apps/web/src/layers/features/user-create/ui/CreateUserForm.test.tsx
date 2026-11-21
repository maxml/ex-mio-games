import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient } from '@/test/utils';
import { CreateUserForm } from './CreateUserForm';

// The form's API call (`POST /api/users`) is driven through MSW (see
// src/test/msw/handlers.ts), so this exercises the full reference flow:
// react-hook-form + Zod -> TanStack Query mutation -> typed http client -> MSW.
describe('CreateUserForm', () => {
  it('renders the email and name fields and the submit button', () => {
    renderWithClient(<CreateUserForm />);

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create user' })).toBeInTheDocument();
  });

  it('shows a Zod validation error and does not submit when the email is invalid', async () => {
    const user = userEvent.setup();
    renderWithClient(<CreateUserForm />);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid email/i);
    // Client-side validation blocks the request, so success never renders.
    expect(screen.queryByText('User created.')).not.toBeInTheDocument();
  });

  it('submits a valid user through the API and reports success', async () => {
    const user = userEvent.setup();
    renderWithClient(<CreateUserForm />);

    await user.type(screen.getByLabelText('Email'), 'grace@example.com');
    await user.type(screen.getByLabelText(/Name/), 'Grace Hopper');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(screen.getByText('User created.')).toBeInTheDocument());
  });
});
