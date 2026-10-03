import {
  Alert,
  Button,
  Code,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { SignedRecordView } from "../api.ts";
import { answerText } from "../../shared/document.ts";
import { Loaded } from "../components/common.tsx";
import { useFormat, useLoad } from "../site.tsx";

export function RecordPage() {
  const { id } = useParams();
  const record = useLoad<SignedRecordView>(`/signatures/${id}`);
  const arrival = useLocation().state as {
    justSigned?: boolean;
    granted?: boolean;
  } | null;
  const format = useFormat();
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <Loaded data={record.data} error={record.error}>
      {(data) => {
        const answers = Object.entries(data.record.answers).map(
          ([key, value]) =>
            [
              data.fields.find((field) => field.key === key)?.label ?? key,
              value,
            ] as const,
        );
        return (
          <Stack>
            {arrival?.justSigned && (
              <Alert
                color={arrival.granted ? "green" : "yellow"}
                title="Signed"
              >
                {arrival.granted
                  ? "That is everything. Keep a copy of the PDF for your records."
                  : "Your signature is recorded. This still needs another person to sign before it is complete."}
              </Alert>
            )}
            <Stack gap={2}>
              <Title order={2}>{data.record.document.title}</Title>
              <Text c="dimmed" size="sm">
                {data.record.clearance.name}, version{" "}
                {data.record.document.version}
              </Text>
            </Stack>
            <Paper withBorder p="md">
              <Stack gap="xs">
                <Text>
                  Signed by <strong>{data.record.signer.name}</strong>,{" "}
                  {data.capacityPhrase}.
                </Text>
                <Text>
                  {data.record.capacity === "attester"
                    ? "Certified"
                    : "Participant"}
                  : {data.record.subject.name}
                </Text>
                <Text>Signed: {format.dateTime(data.signedAt)}</Text>
              </Stack>
            </Paper>
            {answers.length > 0 && (
              <Table withTableBorder>
                <Table.Tbody>
                  {answers.map(([label, value]) => (
                    <Table.Tr key={label}>
                      <Table.Td>{label}</Table.Td>
                      <Table.Td>{answerText(value)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            <Group>
              <Button
                component="a"
                href={`/api/signatures/${data.id}/pdf`}
                target="_blank"
              >
                Open the signed PDF
              </Button>
              <Button variant="light" component={Link} to="/">
                Back to my clearances
              </Button>
              <Button
                variant="subtle"
                onClick={() => setShowEvidence((shown) => !shown)}
              >
                {showEvidence
                  ? "Hide technical evidence"
                  : "Show technical evidence"}
              </Button>
            </Group>
            {showEvidence && (
              <Stack gap="xs">
                <Text size="sm">
                  The passkey signed the SHA-256 hash of the canonical record
                  below. With the public key, authenticator data, client data
                  and signature, the sign-off can be checked with any WebAuthn
                  library, without this application.
                </Text>
                <Code
                  block
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {JSON.stringify(data.evidence, null, 2)}
                </Code>
              </Stack>
            )}
          </Stack>
        );
      }}
    </Loaded>
  );
}
