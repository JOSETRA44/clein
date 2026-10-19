import { ValidationError } from '../../domain/errors.js';
import { CATALOG } from '../catalog.js';

/** Command words: first level, and second level per group (e.g. storage → analyze, largest…). */
function tree(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of CATALOG) {
    const [head, sub] = c.path;
    map.set(head, [...(map.get(head) ?? []), ...(sub ? [sub] : [])]);
  }
  map.set('completion', ['powershell', 'bash']);
  return map;
}

/** Shell completion scripts generated from the catalog, so they never go stale. */
export function renderCompletion(shell: string): string {
  const t = tree();
  if (shell === 'powershell') {
    const entries = [...t].map(([k, v]) => `    '${k}' = @(${v.map(s => `'${s}'`).join(', ')})`).join("\n");
    return `# androidctl completion — add to your $PROFILE:  androidctl completion powershell | Out-String | Invoke-Expression
$__androidctlTree = @{
${entries}
}
Register-ArgumentCompleter -Native -CommandName androidctl -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
    if ($wordToComplete) { $words = @($words | Select-Object -SkipLast 1) }
    $candidates = if ($words.Count -eq 0) { $__androidctlTree.Keys } elseif ($words.Count -eq 1) { $__androidctlTree[$words[0]] } else { @() }
    $candidates | Where-Object { $_ -like "$wordToComplete*" } | Sort-Object | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}`;
  }
  if (shell === 'bash') {
    const cases = [...t].filter(([, v]) => v.length).map(([k, v]) => `    ${k}) COMPREPLY=($(compgen -W "${v.join(' ')}" -- "$cur")) ;;`).join('\n');
    return `# androidctl completion — add to ~/.bashrc:  source <(androidctl completion bash)
_androidctl() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=($(compgen -W "${[...t.keys()].join(' ')}" -- "$cur")); return; fi
  if [ "$COMP_CWORD" -eq 2 ]; then
    case "\${COMP_WORDS[1]}" in
${cases}
    esac
  fi
}
complete -F _androidctl androidctl`;
  }
  throw new ValidationError(`Unsupported shell: ${shell} (powershell, bash)`);
}
