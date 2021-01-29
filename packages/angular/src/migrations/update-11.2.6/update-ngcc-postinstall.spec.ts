import { Tree } from '@angular-devkit/schematics';
import { createEmptyWorkspace } from '@nrwl/workspace/testing';
import { runMigration } from '../../utils/testing';

function createAngularCLIPoweredWorkspace() {
  const tree = createEmptyWorkspace(Tree.empty());
  tree.delete('workspace.json');
  tree.create('angular.json', '{}');
  return tree;
}

describe('Remove ngcc flags from postinstall script', () => {
  it('should remove when there is the full ngcc command', async () => {
    const tree = createAngularCLIPoweredWorkspace();
    tree.overwrite(
      '/package.json',
      JSON.stringify({
        scripts: {
          postinstall:
            'node ./decorate-angular-cli.js && ngcc --properties es2015 browser module main --first-only --create-ivy-entry-points',
        },
      })
    );

    const result = await runMigration('update-ngcc-postinstall', {}, tree);

    const packageJson = JSON.parse(result.read('/package.json').toString());
    expect(packageJson.scripts.postinstall).toEqual(
      'node ./decorate-angular-cli.js && ngcc'
    );
  });

  it('should adjust the ngcc command if there are further commands attached in the postinstall', async () => {
    const tree = createAngularCLIPoweredWorkspace();
    tree.overwrite(
      '/package.json',
      JSON.stringify({
        scripts: {
          postinstall:
            'node ./decorate-angular-cli.js && ngcc --properties es2015 browser module main --first-only --create-ivy-entry-points && echo "hi"',
        },
      })
    );

    const result = await runMigration('update-ngcc-postinstall', {}, tree);

    const packageJson = JSON.parse(result.read('/package.json').toString());
    expect(packageJson.scripts.postinstall).toEqual(
      'node ./decorate-angular-cli.js && ngcc'
    );
  });
});
