import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSkillsPromptForRun } from "./skills.js";
import type { SkillEntry } from "./skills/types.js";

describe("resolveSkillsPromptForRun", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("rewrites managed skill prompt locations into sandbox workspace paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-skills-"));
    try {
      const workspaceManagedPath = path.join(workspace, "skills", "demo-skill", "SKILL.md");
      await fs.mkdir(path.dirname(workspaceManagedPath), { recursive: true });
      await fs.writeFile(workspaceManagedPath, "# demo");

      const managedSkillPath = path.join(
        os.homedir(),
        ".openclaw",
        "skills",
        "demo-skill",
        "SKILL.md",
      );
      const compactedManagedSkillPath = "~/.openclaw/skills/demo-skill/SKILL.md";
      const prompt = `Use the skill. <location>${compactedManagedSkillPath}</location>`;

      const rewritten = resolveSkillsPromptForRun({
        skillsSnapshot: {
          prompt,
          skills: [{ name: "demo-skill" }],
        },
        workspaceDir: workspace,
      });

      expect(rewritten).toContain("<location>skills/demo-skill/SKILL.md</location>");
      expect(rewritten).not.toContain("~/.openclaw/skills/demo-skill/SKILL.md");
      expect(rewritten).not.toContain(managedSkillPath);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
