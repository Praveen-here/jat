'use client';

/**
 * Disconnect asks for confirmation first: it deletes everything stored for the mailbox.
 * It's still a plain form POST, so the browser sends Origin for the backend's CSRF check.
 */
export function DisconnectButton({ accountId, address }: { accountId: string; address: string }) {
  return (
    <form
      action={`/api/mail-accounts/${accountId}/disconnect`}
      method="post"
      onSubmit={(event) => {
        const confirmed = window.confirm(
          `Disconnect ${address}?\n\nThis removes the app's access to this mailbox and deletes everything the tracker stored from it. Your emails in Gmail are not touched.`,
        );
        if (!confirmed) event.preventDefault();
      }}
    >
      <button
        type="submit"
        className="h-7 rounded-md px-2 text-[13px] text-status-rejected-ink transition-colors hover:bg-status-rejected-bg"
      >
        Disconnect
      </button>
    </form>
  );
}
