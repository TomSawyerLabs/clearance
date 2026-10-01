import { Code, Stack, Table, Text, Title } from "@mantine/core";
import type { AuditEntry } from "../../api.ts";
import { Loaded } from "../../components/common.tsx";
import { useFormat, useLoad } from "../../site.tsx";

export function AuditPage() {
  const audit = useLoad<AuditEntry[]>("/admin/audit");
  const format = useFormat();
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Audit log</Title>
        <Text c="dimmed" size="sm">
          The most recent 200 changes: who did what, when, and from which
          network address.
        </Text>
      </Stack>
      <Loaded data={audit.data} error={audit.error}>
        {(entries) => (
          <Table.ScrollContainer minWidth={640}>
            <Table withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>When</Table.Th>
                  <Table.Th>Who</Table.Th>
                  <Table.Th>What</Table.Th>
                  <Table.Th>Details</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {entries.map((entry) => (
                  <Table.Tr key={entry.id}>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>
                      {format.dateTime(entry.at)}
                    </Table.Td>
                    <Table.Td>
                      {entry.actor_name ?? "Nobody signed in"}
                      <Text size="xs" c="dimmed">
                        {entry.ip}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Code>{entry.action}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" style={{ wordBreak: "break-all" }}>
                        {JSON.stringify(entry.detail)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Loaded>
    </Stack>
  );
}
