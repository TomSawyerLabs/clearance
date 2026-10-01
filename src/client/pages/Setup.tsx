import { Button, Stack, Text, TextInput, Title } from "@mantine/core";
import { useState } from "react";
import { registerPasskey } from "../api.ts";
import { Problem, useAction } from "../components/common.tsx";
import { useSite } from "../site.tsx";

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
    </Stack>
  );
}
