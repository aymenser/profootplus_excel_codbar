MERGED CATALOG IMAGE LINKING

Files:
- main.html            Main Supabase catalog. Includes the new "Link images" button.
- link-images.html     New image-linking/review page.
- link-images.js       Finished image pipeline adapted to load products/colors from Supabase and commit images.
- pipeline.js          Original standalone pipeline implementation, kept for backward compatibility with index.html.
- index.html            Original standalone pipeline page, kept for backward compatibility.
- server.js            Existing Bing image-search proxy.

How to run:
1. Put all files in the same folder.
2. Start the Bing proxy with Node:
      node server.js
3. Serve the folder over HTTP (for example with VS Code Live Server, or another static web server).
4. Open main.html.
5. Click "Link images".

Image-linking behavior:
- Products are loaded directly from Supabase.
- Every row in product_colors becomes an independent image-search pipeline.
- Rows are grouped under their parent products.id, so each product branches into its colors.
- Search query uses the parent product designation + that color's code_modele, with the existing pipeline verification logic.
- Manual drag/drop, paste, quick-pick, delete, reorder, Search Window, Retry, and debug-log behavior are preserved.
- Nothing is written to the database during sourcing.
- Commit saves the current A-E URLs to product_colors.images for that color.
- Commit All saves every color result currently loaded, in A-E order.
- Existing database image counts are shown as a small DB badge on each color row.
