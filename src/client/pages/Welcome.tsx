import { Button, Stack, Text, Title } from "@mantine/core";
import { Navigate, useLocation, useNavigate } from "react-router";
import { signIn } from "../api.ts";
import { Problem, useAction } from "../components/common.tsx";
import { useSite } from "../site.tsx";

export function WelcomePage() {
  const { state, refresh } = useSite();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const action = useAction();

  if (state.me) return <Navigate to={from} replace />;

  return (
    <Stack maw={460} mx="auto" mt="xl">
      <Title order={2}>{state.site.name}</Title>
      <Text>Sign in with the passkey you created on this device.</Text>
      <Problem message={action.error} />
      <Button
        loading={action.busy}
        onClick={() =>
          action.run(async () => {
            await signIn();
            await refresh();
            navigate(from, { replace: true });
          })
        }
      >
        Sign in with a passkey
      </Button>
      <Text size="sm" c="dimmed">
        New here? Accounts are created from a link. Ask whoever runs your group
        for theirs. If you have lost your passkey, an administrator can send you
        a link to set up a new one.
      </Text>
    </Stack>
  );
}
