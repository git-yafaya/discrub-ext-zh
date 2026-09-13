/// <reference types="cypress" />

/**
 * E2E coverage for #270 and the #269 import line: a DM whose channel.json
 * spells its type as "DM" lands under Direct Messages, a channel with no
 * type at all lands under Other, and the status log says what the
 * import read.
 *
 * Fixture: test-package-many.zip (channels 600 "DM" and 700 untyped on
 * top of the base package and the 60-message "busy" channel).
 */

describe('Data package channel types (#270)', () => {
  beforeEach(() => {
    cy.login();
    cy.uploadPackage('test-package-many.zip');
    cy.contains('busy').should('be.visible');
  });

  it('files a named-type DM under Direct Messages and counts it in the chip', () => {
    cy.contains('Direct Messages').should('be.visible');
    cy.contains('named-friend').should('be.visible');
    cy.contains(/2 DMs/).should('be.visible');
  });

  it('files an untyped channel under Other and warns in the status log', () => {
    cy.contains('Other').should('be.visible');
    cy.contains('mystery').should('be.visible');
    cy.window().then((win) => {
      const entries = (win as any).__store__.getState().status.entries as { level: string; message: string }[];
      const line = entries.find((e) => e.message.startsWith('Package read:'));
      expect(line, 'import line').to.exist;
      expect(line!.level).to.eq('warning');
      expect(line!.message).to.match(/1 channel had a type Discrub does not recognize/);
    });
  });

  it('opens the untyped channel and lists its messages', () => {
    cy.contains('mystery').click();
    cy.contains('no type at all').should('be.visible');
  });
});
