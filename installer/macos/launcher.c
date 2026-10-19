#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
  (void)argc;

  char executable_path[PATH_MAX];
  if (realpath(argv[0], executable_path) == NULL) {
    perror("realpath");
    return 1;
  }

  char macos_dir_buffer[PATH_MAX];
  strncpy(macos_dir_buffer, executable_path, sizeof(macos_dir_buffer) - 1);
  macos_dir_buffer[sizeof(macos_dir_buffer) - 1] = '\0';
  char *macos_dir = dirname(macos_dir_buffer);

  char script_path[PATH_MAX];
  int written = snprintf(
      script_path,
      sizeof(script_path),
      "%s/../Resources/launcher.sh",
      macos_dir);
  if (written < 0 || written >= (int)sizeof(script_path)) {
    fprintf(stderr, "launcher.sh path is too long\n");
    return 1;
  }

  char resolved_script[PATH_MAX];
  if (realpath(script_path, resolved_script) == NULL) {
    perror("launcher.sh");
    return 1;
  }

  char *const args[] = {"/bin/bash", resolved_script, NULL};
  execv("/bin/bash", args);
  perror("execv");
  return 1;
}
