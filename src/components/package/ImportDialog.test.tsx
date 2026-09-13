import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, waitFor, fireEvent } from '@/test/test-utils';
import ImportDialog, { friendlyImportError } from './ImportDialog';
import { buildFixturePackage } from '@/test/package-fixtures';

describe('friendlyImportError', () => {
  it('maps the worker-clone / out-of-memory family to actionable copy (#210)', () => {
    const raw = "Failed to execute 'postMessage' on 'Worker': Data cannot be cloned, out of memory.";
    expect(friendlyImportError(raw)).toMatch(/ran out of memory/i);
    expect(friendlyImportError('Array buffer allocation failed')).toMatch(/ran out of memory/i);
  });

  it('maps the NotReadableError family to actionable copy (#203)', () => {
    const raw = 'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.';
    const out = friendlyImportError(raw);
    expect(out).toMatch(/Couldn’t read the ZIP file/i);
    expect(out).toMatch(/cloud-synced folder/i);
  });

  it('passes through an unrecognized message unchanged', () => {
    expect(friendlyImportError('Package is missing account/user.json')).toBe(
      'Package is missing account/user.json',
    );
  });
});

describe('<ImportDialog />', () => {
  it('renders upload prompt when open', () => {
    renderWithProviders(<ImportDialog open onClose={() => {}} />);
    expect(screen.getByText(/Drop ZIP here/i)).toBeInTheDocument();
  });

  it('parses a valid package and calls onImported', async () => {
    const onImported = vi.fn();
    const onClose = vi.fn();
    const { store } = renderWithProviders(
      <ImportDialog open onClose={onClose} onImported={onImported} />,
    );

    const blob = await buildFixturePackage();
    const file = new File([blob], 'package.zip', { type: 'application/zip' });

    const input = screen.getByTestId('package-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    await waitFor(() => {
      expect(store.getState().package.status).toBe('ready');
    });
    expect(onImported).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows error alert on invalid package', async () => {
    renderWithProviders(<ImportDialog open onClose={() => {}} />);

    const blob = await buildFixturePackage({ omitUserJson: true });
    const file = new File([blob], 'bad.zip', { type: 'application/zip' });

    const input = screen.getByTestId('package-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/user\.json|missing|failed/i);
  });


  it('hands the File to the import unread (#269)', async () => {
    const { store } = renderWithProviders(<ImportDialog open onClose={() => {}} />);
    const blob = await buildFixturePackage();
    const file = new File([blob], 'package.zip', { type: 'application/zip' });
    const arrayBufferSpy = vi.spyOn(file, 'arrayBuffer');

    const input = screen.getByTestId('package-file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    await waitFor(() => {
      expect(store.getState().package.status).toBe('ready');
    });
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it('shows a determinate bar while bytes are being read (#269)', () => {
    renderWithProviders(<ImportDialog open onClose={() => {}} />, {
      preloadedState: {
        package: {
          status: 'parsing',
          importProgress: { read: 25, total: 100 },
        },
      } as never,
    });
    const bar = screen.getByTestId('package-import-progress');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText(/Reading package… 25%/)).toBeInTheDocument();
  });

  it('maps a storage quota failure to plain copy (#269)', () => {
    expect(friendlyImportError('QuotaExceededError: The quota has been exceeded.')).toMatch(/enough storage space/i);
    expect(friendlyImportError('The requested file could not be read')).not.toMatch(/very large/);
  });
});
