import { createFileRoute } from "@tanstack/react-router";
import { DemoLogin } from "./login";
import { pageHead } from "@/lib/seo";

export const Route = createFileRoute("/demo")({
  ssr: false,
  head: () =>
    pageHead(
      "Interactive Demo Sandbox",
      "Explore Aurelia TimeFlow in an isolated browser sandbox as a Business Admin, Project Manager or Employee.",
    ),
  component: DemoLogin,
});
