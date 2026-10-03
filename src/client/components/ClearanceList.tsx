import { Anchor, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import type { Capacity, ClearanceStatus } from "../api.ts";
import { useFormat } from "../site.tsx";
import { describeStatus, StatusBadge } from "./common.tsx";

/**
 * A person's clearances, each with where it stands. `signAs` is the capacity
 * the viewer would sign in, if any; the sign button appears only where a
 * signature in that capacity is what the clearance is waiting on.
 */
export function ClearanceList({
  subjectId,
  clearances,
  signAs,
}: {
  subjectId: string;
  clearances: ClearanceStatus[];
  signAs: Capacity | null;
}) {
  const format = useFormat();
  if (clearances.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        There is nothing to sign yet.
      </Text>
    );
  }
  return (
    <Stack gap="sm">
      {clearances.map((status) => {
        const { detail } = describeStatus(status);
        const canSign = signAs !== null && status.waitingOn.includes(signAs);
        return (
          <Paper key={status.clearanceId} withBorder p="sm">
            <Group justify="space-between" align="flex-start">
              <Stack gap={4} style={{ flex: 1, minWidth: 180 }}>
                <Group gap="xs">
                  <Text fw={600}>{status.name}</Text>
                  <StatusBadge status={status} />
                </Group>
                {detail && <Text size="sm">{detail}</Text>}
                {status.state === "active" && status.grantedAt && (
                  <Text size="sm" c="dimmed">
                    {status.kind === "certification" ? "Certified" : "Signed"}{" "}
                    {format.date(status.grantedAt)}
                    {status.expiresAt
                      ? `, valid until ${format.date(status.expiresAt)}`
                      : ""}
                  </Text>
                )}
                {status.signatureIds.map((id, index) => (
                  <Anchor
                    key={id}
                    component={Link}
                    to={`/records/${id}`}
                    size="sm"
                  >
                    View signed record
                    {status.signatureIds.length > 1 ? ` ${index + 1}` : ""}
                  </Anchor>
                ))}
              </Stack>
              {canSign && (
                <Button
                  component={Link}
                  to={`/sign/${status.clearanceId}/${subjectId}`}
                  size="sm"
                  variant={
                    status.required || status.state !== "missing"
                      ? "filled"
                      : "light"
                  }
                  style={{ flexShrink: 0 }}
                >
                  {status.kind === "certification"
                    ? "Certify"
                    : "Read and sign"}
                </Button>
              )}
            </Group>
          </Paper>
        );
      })}
    </Stack>
  );
}
