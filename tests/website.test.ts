import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pageDocument, readableText } from '../src/server/brain/website';

/**
 * Reading a brand's own page.
 *
 * No network: the fetch is a fetch, and every mistake worth catching lives in
 * the reduction of a web page to the text the Brain will read. A page carries
 * far more script, navigation and markup than prose, and any of it surviving
 * into the text means the Brain learns a brand's voice from its JavaScript.
 */

describe('reducing a page to what is worth reading', () => {
  it('removes a script rather than only its tags', async () => {
    const text = readableText(
      '<p>Aged in bourbon casks.</p><script>var tracking = "buy now click here";</script>',
    );

    // Stripping tags alone leaves the code itself sitting in the prose, and
    // the Brain would read "var tracking" as something the brand says.
    assert.match(text, /Aged in bourbon casks/);
    assert.ok(!text.includes('tracking'), `script survived: ${text}`);
    assert.ok(!text.includes('var '), `script survived: ${text}`);
  });

  it('removes styles and comments too', async () => {
    const text = readableText(
      '<style>.hero{color:#0b5240}</style><!-- internal note --><p>Eleven botanicals.</p>',
    );
    assert.equal(text, 'Eleven botanicals.');
  });

  it('keeps paragraphs apart instead of running them together', async () => {
    const text = readableText('<p>Single malt.</p><p>Non-chill filtered.</p><li>45% ABV</li>');

    // Without this, three separate claims arrive as one sentence and the
    // Brain reads them as a single fact.
    assert.match(text, /Single malt\.\s*\n/);
    assert.match(text, /Non-chill filtered\./);
    assert.match(text, /45% ABV/);
  });

  it('turns entities back into the characters they stand for', async () => {
    const text = readableText('<p>Rampur&nbsp;&amp; Sangam &#8212; Rampur&#39;s own</p>');
    assert.match(text, /Rampur & Sangam/);
    assert.match(text, /Rampur's own/);
  });

  it('does not mistake a tag inside text for markup it should drop', async () => {
    const text = readableText('<p>Bottled at &lt;46% ABV&gt;</p>');
    assert.match(text, /<46% ABV>/);
  });
});

describe('what gets stored for a page', () => {
  it('keeps the address in the text, not only in the filename', async () => {
    const document = pageDocument({
      url: 'https://rampursinglemalt.com/asava/',
      title: 'Asava - Rampur Distillery',
      text: 'Finished in Indian Cabernet Sauvignon casks.',
    });

    // The Brain reads the text. A claim about a product is worth more when the
    // thing reading it can see where it came from.
    assert.match(document, /rampursinglemalt\.com\/asava/);
    assert.ok(document.startsWith('Asava - Rampur Distillery'));
    assert.match(document, /Cabernet Sauvignon/);
  });
});
