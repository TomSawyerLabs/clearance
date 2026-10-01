import { Button, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { api, type Passkey, post, registerPasskey } from "../api.ts";
import { Loaded, Problem, useAction } from "../components/common.tsx";
import { useFormat, useLoad, useSite } from "../site.tsx";

export function AccountPage() {
  const { state } = useSite();
  const passkeys = useLoad<Passkey[]>("/me/passkeys");
  const format = useFormat();
  const action = useAction();

  return (
    <Stack gap="lg">
      <Stack gap={2}>
        <Title order={2}>{state.me?.name}</Title>
        <Text c="dimmed" size="sm">
          Your name appears on what you sign. Ask an administrator if it needs
          correcting.
        </Text>
      </Stack>

      <Stack gap="sm">
        <Title order={3}>Passkeys</Title>
        <Text size="sm">
          A passkey lives on one device, or in one password manager. Add one on
          each device you want to sign in from, so that losing a device does not
          lock you out.
        </Text>
        <Loaded data={passkeys.data} error={passkeys.error}>
          {(list) => (
            <Stack gap="xs">
              {list.map((passkey) => (
                <Paper key={passkey.id} withBorder p="sm">
                  <Group justify="space-between">
                    <Stack gap={0}>
                      <Text fw={600}>{passkey.label}</Text>
                      <Text size="sm" c="dimmed">
                        Added {format.date(passkey.created_at)}
                        {passkey.last_used_at
                          ? `, last used ${format.date(passkey.last_used_at)}`
                          : ""}
                      </Text>
                    </Stack>
                    {list.length > 1 && (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={action.busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Remove the passkey "${passkey.label}"?`,
                            )
                          )
                            return;
                          void action.run(async () => {
                            await api(
                              "DELETE",
                              `/me/passkeys/${encodeURIComponent(passkey.id)}`,
                            );
                            await passkeys.reload();
                          });
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}
        </Loaded>
        <Problem message={action.error} />
        <Group>
          <Button
            variant="light"
            loading={action.busy}
            onClick={() =>
              action.run(async () => {
                await registerPasskey({});
                await passkeys.reload();
              })
            }
          >
            Add a passkey on this device
          </Button>
        </Group>
      </Stack>

      <Group>
        <Button
          variant="default"
          onClick={async () => {
            await post("/auth/logout");
            // A full page load, so nothing of the signed-in session lingers in memory.
            window.location.assign("/welcome");
          }}
        >
          Sign out
        </Button>
      </Group>
    </Stack>
  );
}
