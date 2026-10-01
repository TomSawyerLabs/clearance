import "@mantine/core/styles.css";
import { Alert, Center, Loader, MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { SiteProvider } from "./site.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <SiteProvider
        loading={
          <Center h="100vh">
            <Loader />
          </Center>
        }
        failed={(message) => (
          <Center h="100vh" p="md">
            <Alert color="red" title="Could not reach the server">
              {message}
            </Alert>
          </Center>
        )}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SiteProvider>
    </MantineProvider>
  </StrictMode>,
);
