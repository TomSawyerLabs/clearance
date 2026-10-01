import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { type GroupListItem, post } from "../api.ts";
import { Loaded, Problem, useAction } from "../components/common.tsx";
import { useLoad, useSite } from "../site.tsx";

function NewGroup() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const action = useAction();
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const created = await post<{ id: string }>("/groups", {
              name,
              code: code || null,
            });
            navigate(`/groups/${created.id}`);
          });
        }}
      >
        <Stack>
          <Title order={4}>New group</Title>
          <Group grow align="flex-start">
            <TextInput
              label="Name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
            />
            <TextInput
              label="Number or code"
              description="Optional. For a team, its team number."
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </Group>
          <Problem message={action.error} />
          <Group>
            <Button type="submit" loading={action.busy} disabled={!name.trim()}>
              Create group
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

export function GroupsPage() {
  const { state } = useSite();
  const groups = useLoad<GroupListItem[]>("/groups");

  return (
    <Stack gap="lg">
      <Title order={2}>Groups</Title>
      <Loaded data={groups.data} error={groups.error}>
        {(list) =>
          list.length === 0 ? (
            <Text c="dimmed">
              {state.me?.admin
                ? "There are no groups yet. Create one, then make a manager link for whoever runs it."
                : "You are not in any group."}
            </Text>
          ) : (
            <Stack gap="sm">
              {list.map((group) => (
                <Paper key={group.id} withBorder p="sm">
                  <Group justify="space-between">
                    <Group gap="xs">
                      {group.canManage ? (
                        <Anchor
                          component={Link}
                          to={`/groups/${group.id}`}
                          fw={600}
                        >
                          {group.name}
                        </Anchor>
                      ) : (
                        <Text fw={600}>{group.name}</Text>
                      )}
                      {group.code && (
                        <Badge variant="outline">{group.code}</Badge>
                      )}
                      {group.role === "manager" && (
                        <Badge color="blue">Manager</Badge>
                      )}
                      {group.archived && <Badge color="gray">Archived</Badge>}
                    </Group>
                    <Text size="sm" c="dimmed">
                      {group.members}{" "}
                      {group.members === 1 ? "person" : "people"}
                    </Text>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )
        }
      </Loaded>
      {state.me?.admin && <NewGroup />}
    </Stack>
  );
}
