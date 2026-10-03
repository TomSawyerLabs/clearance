import {
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Radio,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { type ClearanceDto, post } from "../../api.ts";
import { Loaded, Problem, useAction } from "../../components/common.tsx";
import { useLoad } from "../../site.tsx";

function NewClearance() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<ClearanceDto["kind"]>("release");
  const action = useAction();
  return (
    <Paper withBorder p="md">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(async () => {
            const created = await post<ClearanceDto>("/clearances", {
              name,
              description,
              kind,
            });
            navigate(`/admin/clearances/${created.id}`);
          });
        }}
      >
        <Stack>
          <Title order={4}>New document</Title>
          <TextInput
            label="Name"
            description='What people are cleared for by signing it, e.g. "General release".'
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
          />
          <Radio.Group
            label="Who signs it"
            description="Fixed once the document exists."
            value={kind}
            onChange={(value) => setKind(value as ClearanceDto["kind"])}
          >
            <Stack gap="xs" mt="xs">
              <Radio
                value="release"
                label="The person, or a parent or guardian for a minor: a release"
              />
              <Radio
                value="certification"
                label="A mentor, attesting that the person is trained: a certification"
              />
            </Stack>
          </Radio.Group>
          <Textarea
            label="Description"
            description="Optional. A note for administrators."
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            autosize
          />
          <Problem message={action.error} />
          <Group>
            <Button type="submit" loading={action.busy} disabled={!name.trim()}>
              Create, then write the text
            </Button>
          </Group>
        </Stack>
      </form>
    </Paper>
  );
}

export function ClearancesPage() {
  const clearances = useLoad<ClearanceDto[]>("/clearances");
  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={2}>Documents</Title>
        <Text c="dimmed" size="sm">
          Each document is something signed to hold a clearance: a liability
          release the person signs, or a certification a mentor signs for them.
        </Text>
      </Stack>
      <Loaded data={clearances.data} error={clearances.error}>
        {(list) => (
          <Stack gap="sm">
            {list.length === 0 && <Text c="dimmed">No documents yet.</Text>}
            {list.map((clearance) => (
              <Paper key={clearance.id} withBorder p="sm">
                <Group justify="space-between">
                  <Group gap="xs">
                    <Anchor
                      component={Link}
                      to={`/admin/clearances/${clearance.id}`}
                      fw={600}
                    >
                      {clearance.name}
                    </Anchor>
                    {clearance.kind === "certification" && (
                      <Badge color="grape">Certification</Badge>
                    )}
                    {clearance.requiredForAll && (
                      <Badge color="blue">Required</Badge>
                    )}
                    {clearance.archived && <Badge color="gray">Archived</Badge>}
                    {!clearance.current && (
                      <Badge color="yellow">No text published</Badge>
                    )}
                  </Group>
                  {clearance.current && (
                    <Text size="sm" c="dimmed">
                      Version {clearance.current.version}
                    </Text>
                  )}
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </Loaded>
      <NewClearance />
    </Stack>
  );
}
