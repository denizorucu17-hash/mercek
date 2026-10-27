import { createFileRoute } from "@tanstack/react-router";
import { Mercek } from "@/components/browser/mercek";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Mercek />;
}
