import {
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group as Row,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, type Group, post } from "../api.ts";
import {
  describeStatus,
  Loaded,
  Problem,
  ShareLink,
  useAction,
} from "../components/common.tsx";
import { useFormat, useLoad, useSite } from "../site.tsx";

type Member = Group["members"][number];

function MemberRow({
  group,
  member,
  reload,
}: {
  group: Group;
  member: Member;
  reload(): Promise<void>;
}) {
  const { state } = useSite();
  const action = useAction();
  const run = (work: () => Promise<unknown>) =>
    action.run(async () => {
      await work();
      await reload();
    });

  return (
    <Table.Tr>
      <Table.Td>
        <Anchor component={Link} to={`/people/${member.id}`} fw={600}>
          {member.name}
        </Anchor>
        <Row gap={4} mt={4}>
          {member.role === "manager" && <Badge color="blue">Manager</Badge>}
          {member.minor && <Badge variant="outline">Minor</Badge>}
          {member.managed && <Badge color="gray">Run by a guardian</Badge>}
          {member.needsGuardian && (
            <Badge color="red">No guardian linked</Badge>
          )}
        </Row>
        {member.guardians.map((guardian) => (
          <Checkbox
            key={guardian.guardianshipId}
            mt={6}
            size="xs"
            label={`Guardian: ${guardian.name}. ${guardian.verified ? "Identity checked." : "Tick once you have checked who they are."}`}
            checked={guardian.verified}
            disabled={action.busy}
            onChange={(event) => {
              const verified = event.currentTarget.checked;
              void run(() =>
                api(
                  "PUT",
                  `/guardianships/${guardian.guardianshipId}/verified`,
                  { verified },
                ),
              );
            }}
          />
        ))}
        <Problem message={action.error} />
      </Table.Td>
      <Table.Td>
        <Stack gap={6}>
          {member.clearances.length === 0 && (
            <Text size="sm" c="dimmed">
              Nothing to sign yet
            </Text>
          )}
          {member.clearances.map((status) => {
            const { color, label, detail } = describeStatus(status);
            // A manager certifies from here; releases are the family's to sign.
            const canCertify =
              status.kind === "certification" &&
              status.waitingOn.includes("attester") &&
              member.id !== state.me?.id;
            return (
              <div key={status.clearanceId}>
                <Row gap={6}>
                  <Badge color={color} variant="light">
                    {label}
                  </Badge>
                  <Text size="sm">{status.name}</Text>
                  {canCertify && (
                    <Button
                      component={Link}
                      to={`/sign/${status.clearanceId}/${member.id}`}
                      size="compact-xs"
                      variant="light"
                    >
                      Certify
                    </Button>
                  )}
                </Row>
                {detail && (
                  <Text size="xs" c="dimmed">
                    {detail}
                  </Text>
                )}
              </div>
            );
          })}
        </Stack>
      </Table.Td>
      <Table.Td>
        <Stack gap={4} align="flex-start">
          {!member.minor && (
            <Button
              size="compact-xs"
              variant="subtle"
              disabled={action.busy}
              onClick={() =>
                run(() =>
                  api("PUT", `/groups/${group.id}/members/${member.id}`, {
                    role: member.role === "manager" ? "member" : "manager",
                  }),
                )
              }
            >
              {member.role === "manager"
                ? "Make a regular member"
                : "Make a manager"}
            </Button>
          )}
          {member.id !== state.me?.id && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    `Remove ${member.name} from ${group.name}? Their signed records are kept.`,
                  )
                )
                  return;
                void run(() =>
                  api("DELETE", `/groups/${group.id}/members/${member.id}`),
                );
              }}
            >
              Remove from group
            </Button>
          )}
        </Stack>
      </Table.Td>
    </Table.Tr>
  );
}

function Links({ group, reload }: { group: Group; reload(): Promise<void> }) {
  const { state } = useSite();
  const format = useFormat();
  const action = useAction();
  const create = (kind: "group_member" | "group_manager") =>
    action.run(async () => {
      await post(`/groups/${group.id}/invites`, { kind });
      await reload();
    });

  return (
    <Stack gap="sm">
      <Title order={3}>Links</Title>
      <Text size="sm">
        Give the member link to{" "}
        {state.site.guardiansEnabled
          ? "students and their parents"
          : "the people joining"}
        . Anyone who opens it can join this group, so turn a link off if it gets
        out.
      </Text>
      {group.invites.map((invite) => (
        <Stack key={invite.id} gap={4}>
          <ShareLink
            token={invite.token!}
            note={
              <>
                <strong>
                  {invite.kind === "group_manager"
                    ? "Manager link"
                    : "Member link"}
                </strong>
                {`, made ${format.date(invite.createdAt)}, used ${invite.uses} ${invite.uses === 1 ? "time" : "times"}`}
                {invite.expiresAt
                  ? `, expires ${format.date(invite.expiresAt)}`
                  : ""}
              </>
            }
          />
          <Row>
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              disabled={action.busy}
              onClick={() =>
                action.run(async () => {
                  await api("DELETE", `/invites/${invite.id}`);
                  await reload();
                })
              }
            >
              Turn this link off
            </Button>
          </Row>
        </Stack>
      ))}
      <Problem message={action.error} />
      <Row>
        <Button
          variant="light"
          loading={action.busy}
          onClick={() => create("group_member")}
        >
          New member link
        </Button>
        <Button
          variant="light"
          loading={action.busy}
          onClick={() => create("group_manager")}
        >
          New manager link
        </Button>
      </Row>
    </Stack>
  );
}

function Details({ group, reload }: { group: Group; reload(): Promise<void> }) {
  const [name, setName] = useState(group.name);
  const [code, setCode] = useState(group.code ?? "");
  const action = useAction();
  const save = (patch: Record<string, unknown>) =>
    action.run(async () => {
      await api("PATCH", `/groups/${group.id}`, patch);
      await reload();
    });
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({ name, code: code || null });
        }}
      >
        <Stack>
          <Title order={4}>Group details</Title>
          <Row grow align="flex-start">
            <TextInput
              label="Name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
            />
            <TextInput
              label="Number or code"
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
            />
          </Row>
          <Problem message={action.error} />
          <Row>
            <Button
              type="submit"
              variant="light"
              loading={action.busy}
              disabled={!name.trim()}
            >
              Save
            </Button>
            <Button
              variant="subtle"
              color="gray"
              disabled={action.busy}
              onClick={() => save({ archived: !group.archived })}
            >
              {group.archived ? "Restore this group" : "Archive this group"}
            </Button>
          </Row>
        </Stack>
      </form>
    </Paper>
  );
}

export function GroupPage() {
  const { id } = useParams();
  const group = useLoad<Group>(`/groups/${id}`);

  return (
    <Loaded data={group.data} error={group.error}>
      {(data) => {
        const outstanding = data.members.filter((member) =>
          member.clearances.some(
            (status) => status.required && status.state !== "active",
          ),
        ).length;
        return (
          <Stack gap="xl">
            <Stack gap={4}>
              <Row gap="xs">
                <Title order={2}>{data.name}</Title>
                {data.code && (
                  <Badge variant="outline" size="lg">
                    {data.code}
                  </Badge>
                )}
                {data.archived && <Badge color="gray">Archived</Badge>}
              </Row>
              <Text c="dimmed">
                {data.members.length}{" "}
                {data.members.length === 1 ? "person" : "people"}
                {data.members.length > 0 &&
                  (outstanding
                    ? `, ${outstanding} with something required still to sign`
                    : ", all required clearances current")}
              </Text>
            </Stack>

            {data.members.length > 0 && (
              <Table.ScrollContainer minWidth={640}>
                <Table withTableBorder verticalSpacing="sm">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Person</Table.Th>
                      <Table.Th>Clearances</Table.Th>
                      <Table.Th />
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {data.members.map((member) => (
                      <MemberRow
                        key={member.id}
                        group={data}
                        member={member}
                        reload={group.reload}
                      />
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}

            <Links group={data} reload={group.reload} />
            <Details
              key={`${data.name}|${data.code}`}
              group={data}
              reload={group.reload}
            />
          </Stack>
        );
      }}
    </Loaded>
  );
}
