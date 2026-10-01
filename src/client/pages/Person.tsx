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
import { Link, useParams } from "react-router";
import { type Person, post } from "../api.ts";
import { ClearanceList } from "../components/ClearanceList.tsx";
import { Loaded, Problem, useAction } from "../components/common.tsx";
import { useFormat, useLoad } from "../site.tsx";

const CAPACITY = {
  self: "For themself",
  guardian: "As guardian",
  minor: "As the student",
} as const;

/** One person's standing and signed records, for a manager, guardian or admin. */
export function PersonPage() {
  const { id } = useParams();
  const person = useLoad<Person>(`/people/${id}`);
  const format = useFormat();
  const action = useAction();

  return (
    <Loaded data={person.data} error={person.error}>
      {(data) => {
        const oversees =
          data.relation === "manager" || data.relation === "admin";
        return (
          <Stack gap="lg">
            <Group gap="xs">
              <Title order={2}>{data.name}</Title>
              {data.minor && <Badge color="blue">Minor</Badge>}
              {data.managed && <Badge color="gray">Run by a guardian</Badge>}
              {data.needsGuardian && (
                <Badge color="red">No guardian linked</Badge>
              )}
            </Group>

            <Stack gap="sm">
              <Title order={3}>Clearances</Title>
              <ClearanceList
                subjectId={data.id}
                clearances={data.clearances}
                signAs={
                  data.relation === "guardian" && data.minor ? "guardian" : null
                }
              />
              <Problem message={action.error} />
              {oversees &&
                data.clearances
                  .filter(
                    (status) => status.state === "active" && status.grantId,
                  )
                  .map((status) => (
                    <Group key={status.clearanceId}>
                      <Button
                        size="xs"
                        color="red"
                        variant="light"
                        loading={action.busy}
                        onClick={() => {
                          const reason = window.prompt(
                            `Revoke "${status.name}" for ${data.name}? Give a reason:`,
                          );
                          if (reason === null) return;
                          void action.run(async () => {
                            await post(`/grants/${status.grantId}/revoke`, {
                              reason,
                            });
                            await person.reload();
                          });
                        }}
                      >
                        Revoke {status.name}
                      </Button>
                    </Group>
                  ))}
            </Stack>

            <Stack gap="sm">
              <Title order={3}>Signed records</Title>
              {data.signatures.length === 0 ? (
                <Text c="dimmed" size="sm">
                  Nothing has been signed yet.
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={520}>
                  <Table withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Document</Table.Th>
                        <Table.Th>Signed by</Table.Th>
                        <Table.Th>When</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.signatures.map((signature) => (
                        <Table.Tr key={signature.id}>
                          <Table.Td>
                            <Anchor
                              component={Link}
                              to={`/records/${signature.id}`}
                            >
                              {signature.title} (v{signature.version})
                            </Anchor>
                          </Table.Td>
                          <Table.Td>
                            {signature.signerName}
                            <Text size="xs" c="dimmed">
                              {CAPACITY[signature.capacity]}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            {format.dateTime(signature.signedAt)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Stack>
          </Stack>
        );
      }}
    </Loaded>
  );
}
