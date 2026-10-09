# >>> claude-auto-retry >>>
# Installed by `claude-auto-retry install`. Autoloaded by fish from functions/claude.fish.
function claude --description 'claude, watched by claude-auto-retry'
    # Degrade to plain claude if already inside a wrapped session, or if the launcher is
    # gone (package removed without `claude-auto-retry uninstall`) — an orphaned wrapper
    # must never break the claude command.
    if test "$CLAUDE_AUTO_RETRY_ACTIVE" = 1; or not test -e "__LAUNCHER_PATH__"
        command claude $argv
        return $status
    end
    # `env VAR=1 cmd` scopes the variable to this one command, so there is nothing to clean up
    # (and nothing to leak) if the session is interrupted.
    env CLAUDE_AUTO_RETRY_ACTIVE=1 node "__LAUNCHER_PATH__" $argv
end
# <<< claude-auto-retry <<<
