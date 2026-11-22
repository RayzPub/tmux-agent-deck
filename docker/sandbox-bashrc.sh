# System-wide shell defaults for CCNOW Docker Sandbox
# Sourced by login shells (/etc/profile.d/) and interactive bash (/etc/bash.bashrc).

for _ccnow_dir in "$HOME/.local/bin" "$HOME/.kimi-code/bin"; do
  if [ -d "$_ccnow_dir" ] || [ "$_ccnow_dir" = "$HOME/.local/bin" ] || [ "$_ccnow_dir" = "$HOME/.kimi-code/bin" ]; then
    case ":$PATH:" in
      *":$_ccnow_dir:"*) ;;
      *) PATH="$_ccnow_dir:$PATH" ;;
    esac
  fi
done
unset _ccnow_dir
export PATH

export TERM="${TERM:-xterm-256color}"
export COLORTERM="${COLORTERM:-truecolor}"
export EDITOR="${EDITOR:-nano}"

# Interactive shell conveniences
case $- in
  *i*)
    alias ls='ls --color=auto'
    alias ll='ls -alF'
    alias la='ls -A'
    alias grep='grep --color=auto'
    if [ -n "${BASH_VERSION:-}" ]; then
      PS1='\[\033[01;36m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
    fi
    ;;
esac
