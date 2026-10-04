import { Switch } from "react-aria-components";
import type { Theme } from "./theme.ts";

interface ThemeSwitchProps {
  theme: Theme;
  onChange: (theme: Theme) => void;
}

/**
 * The dark-theme switch. Built on React Aria's Switch, which supplies the keyboard behaviour, focus handling and screen-reader semantics;
 * this is the pattern for every interactive control in the app (ADR-0014 §1).
 */
export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  return (
    <Switch
      className="theme-switch"
      isSelected={theme === "dark"}
      onChange={(isDark) => onChange(isDark ? "dark" : "light")}
    >
      <span className="theme-switch__track" aria-hidden="true">
        <span className="theme-switch__thumb" />
      </span>
      Dark theme
    </Switch>
  );
}
