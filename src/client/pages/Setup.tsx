import {
  Alert,
  Button,
  Divider,
  FileButton,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { ApiError, registerPasskey } from "../api.ts";
import { Problem, useAction } from "../components/common.tsx";
import { useSite } from "../site.tsx";

/** An empty installation can be started from a backup instead of from nothing. */
function Restore() {
  const { refresh } = useSite();
  const action = useAction();
  const [moved, setMoved] = useState<string | null>(null);

  async function restore(file: File | null) {
    if (!file) return;
    await action.run(async () => {
      const response = await fetch("/api/setup/restore", {
        method: "POST",
        body: file,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ApiError(
          response.status,
          data?.error ?? "The restore failed.",
          null,
        );
      }
      // The backup carries the address of the site it was taken from, and
      // passkeys only work there. Say so instead of failing mysteriously.
      if (data.origin && data.origin !== window.location.origin) {
        setMoved(data.origin);
      } else {
        await refresh();
      }
    });
  }

  if (moved) {
    return (
      <Alert color="yellow" title="Restored, but this is a different address">
        The backup came from {moved}, and everyone's passkeys are tied to that
        address. Serve this installation there, then sign in as usual. If the
        address really has changed, see “If you lock yourself out” in the
        deployment guide.
      </Alert>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="sm">
        Moving an existing installation, or recovering one? Restore its backup
        file here. Everyone keeps their account, their passkeys and their signed
        records.
      </Text>
      <Problem message={action.error} />
      <FileButton onChange={restore} accept=".gz,.ndjson">
        {(props) => (
          <Button {...props} variant="light" loading={action.busy}>
            Restore from a backup file
          </Button>
        )}
      </FileButton>
    </Stack>
  );
}

/** Shown to everyone until the first administrator exists. */
export function SetupPage() {
  const { refresh } = useSite();
  const [name, setName] = useState("");
  const action = useAction();

  return (
    <Stack maw={460} mx="auto" mt="xl">
      <Title order={2}>Set up this site</Title>
      <Text>
        Nobody has an account here yet. The first person to create one becomes
        the administrator, so do this now.
      </Text>
      <Text size="sm" c="dimmed">
        You will sign in with a passkey: your device's fingerprint, face or PIN.
        There is no password. The address in your browser right now (
        {window.location.origin}) is recorded as this site's address, and
        passkeys are tied to it.
      </Text>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await registerPasskey({ name });
            await refresh();
          });
        }}
      >
        <Stack>
          <TextInput
            label="Your name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            autoFocus
          />
          <Problem message={action.error} />
          <Button type="submit" loading={action.busy} disabled={!name.trim()}>
            Create administrator account
          </Button>
        </Stack>
      </form>
      <Divider label="Or" />
      <Restore />
    </Stack>
  );
}
