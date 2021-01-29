import { chain, SchematicContext, Tree } from '@angular-devkit/schematics';
import { updateJsonInTree } from '@nrwl/workspace';
import { formatFiles } from '@nrwl/workspace';

const udpateNgccPostinstallScript = (host: Tree, context: SchematicContext) => {
  updateJsonInTree('package.json', (json) => {
    if (
      json.scripts &&
      json.scripts.postinstall &&
      json.scripts.postinstall.includes('ngcc')
    ) {
      // if exists, add execution of this script
      json.scripts.postinstall = json.scripts.postinstall.replace(
        /(ngcc.*).[&&]*/,
        'ngcc'
      );
    }
    return json;
  })(host, context);
};

export default function () {
  return chain([udpateNgccPostinstallScript, formatFiles()]);
}
