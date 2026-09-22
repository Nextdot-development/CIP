-- What the check was actually looking at.
--
-- A deck is mostly not adverts. Running one through the checker page by page
-- flagged its title slide, its dividers and its blank pages for lacking a logo
-- in the top-right and not showing the product - all true, and none of it a
-- fault, because those rules are about advertising and a divider is not an
-- advert. Fifteen of nineteen pages came back needing fixing, which is the kind
-- of result that teaches a reviewer to ignore the tool.
--
-- The model is now asked what it is looking at before it is asked what is wrong
-- with it, and the answer is kept: a page recorded as document_page or blank
-- was not judged, and a report that says "25 rules passed" about a blank page
-- is claiming work it did not do.

alter table creative_checks
  add column if not exists asset_kind text not null default 'creative'
    check (asset_kind in ('creative', 'document_page', 'blank'));
