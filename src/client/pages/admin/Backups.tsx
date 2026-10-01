import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { api, type BackupStatus } from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
import { useFormat, useLoad } from "../../site.tsx";

function megabytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} kB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function Schedule({
  status,
  reload,
}: {
  status: BackupStatus;
  reload(): Promise<void>;
}) {
  const [everyHours, setEveryHours] = useState(status.everyHours);
  const [keep, setKeep] = useState(status.keep);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            await api("PATCH", "/admin/settings", {
              backupEveryHours: everyHours,
              backupKeep: keep,
            });
            await reload();
            setSaved(true);
          });
        }}
      >
        <Stack>
          <Title order={4}>Schedule</Title>
          <Group align="flex-start">
            <NumberInput
              label="Hours between automatic backups"
              description="0 turns automatic backups off."
              value={everyHours}
              onChange={(value) => {
                setSaved(false);
                if (typeof value === "number") setEveryHours(value);
              }}
              min={0}
              max={720}
              allowDecimal={false}
              maw={260}
            />
            <NumberInput
              label="How many to keep"
              description="The oldest is deleted when there are more."
              value={keep}
              onChange={(value) => {
                setSaved(false);
                if (typeof value === "number") setKeep(value);
              }}
              min={1}
              max={365}
              allowDecimal={false}
              maw={260}
            />
          </Group>
          <Problem message={action.error} />
          <Group>
            <Button type="submit" variant="light" loading={action.busy}>
              Save schedule
            </Button>
            {saved && <Text c="green">Saved.</Text>}
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

export function BackupsPage() {
  const status = useLoad<BackupStatus>("/admin/backups");
  const format = useFormat();

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Backups</Title>
        <Text c="dimmed" size="sm">
          A backup is one file holding everything: people, passkeys, groups,
          documents and every signed record. It restores onto any kind of
          Clearance installation, from the setup page of an empty one.
        </Text>
      </Stack>

      <Group>
        <Button component="a" href="/api/admin/backup">
          Download a backup now
        </Button>
      </Group>
      <Text size="sm">
        Keep downloaded backups somewhere safe. Anyone holding one holds every
        record in it.
      </Text>

      <Loaded data={status.data} error={status.error}>
        {(data) =>
          data.automatic ? (
            <Stack gap="lg">
              <Stack gap="sm">
                <Title order={3}>Automatic backups</Title>
                <Text size="sm">
                  Written to the <code>backups</code> folder beside the database
                  on the server. They protect against a damaged database, not
                  against losing the server, so copy that folder somewhere else
                  as well.
                </Text>
                {data.snapshots.length === 0 ? (
                  <Alert color="yellow">
                    {data.everyHours === 0
                      ? "Automatic backups are turned off."
                      : "None yet. The first is written within a few minutes of there being something to back up."}
                  </Alert>
                ) : (
                  <Table withTableBorder maw={520}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Written</Table.Th>
                        <Table.Th>Size</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {data.snapshots.map((snapshot) => (
                        <Table.Tr key={snapshot.name}>
                          <Table.Td>{format.dateTime(snapshot.at)}</Table.Td>
                          <Table.Td>{megabytes(snapshot.bytes)}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                )}
              </Stack>
              <Schedule status={data} reload={status.reload} />
            </Stack>
          ) : (
            <Alert color="blue" title="No automatic backups here">
              This installation runs without a disk of its own, so it cannot
              keep backup files. Rely on the database provider's own history,
              and download a backup from this page from time to time.
            </Alert>
          )
        }
      </Loaded>
    </Stack>
  );
}
