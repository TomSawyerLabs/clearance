import {
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link } from "react-router";
import { type AdminUser, api, post } from "../../api.ts";
import {
  Loaded,
  Problem,
  ShareLink,
  useAction,
} from "../../components/common.tsx";
import { useLoad, useSite } from "../../site.tsx";

function UserRow({
  user,
  reload,
}: {
  user: AdminUser;
  reload(): Promise<void>;
}) {
  const { state } = useSite();
  const action = useAction();
  const [recovery, setRecovery] = useState<string | null>(null);
  const isMe = user.id === state.me?.id;
  const patch = (body: Record<string, unknown>) =>
    action.run(async () => {
      await api("PATCH", `/admin/users/${user.id}`, body);
      await reload();
    });

  return (
    <Table.Tr>
      <Table.Td>
        <Anchor component={Link} to={`/people/${user.id}`} fw={600}>
          {user.name}
        </Anchor>
        <Group gap={4} mt={4}>
          {user.admin && <Badge color="blue">Administrator</Badge>}
          {user.minor && <Badge variant="outline">Minor</Badge>}
          {user.managed && <Badge color="gray">Run by a guardian</Badge>}
          {user.needsGuardian && <Badge color="red">No guardian linked</Badge>}
          {user.disabled && <Badge color="red">Turned off</Badge>}
        </Group>
        <Problem message={action.error} />
        {recovery && (
          <ShareLink
            token={recovery}
            note={`Send this to ${user.name}. It sets up a new passkey for their account, works once, and expires in 2 days. Anyone holding it can sign in as them.`}
          />
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">
          {user.passkeys} {user.passkeys === 1 ? "passkey" : "passkeys"}
        </Text>
      </Table.Td>
      <Table.Td>
        <Stack gap={4} align="flex-start">
          <Button
            size="compact-xs"
            variant="subtle"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const result = await post<{ token: string }>(
                  `/admin/users/${user.id}/passkey-invite`,
                );
                setRecovery(result.token);
              })
            }
          >
            Make a new-passkey link
          </Button>
          {!isMe && !user.minor && (
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={action.busy}
              onClick={() => patch({ admin: !user.admin })}
            >
              {user.admin
                ? "Remove administrator access"
                : "Make an administrator"}
            </Button>
          )}
          {!isMe && (
            <Button
              size="compact-xs"
              variant="subtle"
              color={user.disabled ? undefined : "red"}
              disabled={action.busy}
              onClick={() => patch({ disabled: !user.disabled })}
            >
              {user.disabled
                ? "Turn the account back on"
                : "Turn the account off"}
            </Button>
          )}
        </Stack>
      </Table.Td>
    </Table.Tr>
  );
}

export function UsersPage() {
  const users = useLoad<AdminUser[]>("/admin/users");
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>People</Title>
        <Text c="dimmed" size="sm">
          Everyone with an account. People are never deleted, because their
          signed records refer to them; turn an account off instead.
        </Text>
      </Stack>
      <Loaded data={users.data} error={users.error}>
        {(list) => (
          <Table.ScrollContainer minWidth={560}>
            <Table withTableBorder verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Person</Table.Th>
                  <Table.Th>Sign-in</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((user) => (
                  <UserRow key={user.id} user={user} reload={users.reload} />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Loaded>
    </Stack>
  );
}
