import type { ReactNode } from 'react';
import { money, type Product } from './api';

/**
 * The catalogue.
 *
 * Each card names the refund rule the item is there to exercise. That is
 * deliberate: a tester should be able to choose an item *because* they want to
 * see a final-sale denial, rather than buying a lamp and hoping the assistant
 * has something interesting to say about it.
 */
export function Catalogue({
  products,
  onAdd,
  inCart,
}: {
  products: readonly Product[];
  onAdd: (productId: string) => void;
  inCart: (productId: string) => number;
}): ReactNode {
  return (
    <div className="grid">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} onAdd={onAdd} quantity={inCart(product.id)} />
      ))}
    </div>
  );
}

function addLabel(soldOut: boolean, inCart: number): string {
  if (soldOut) {
    return 'Sold out';
  }
  return inCart > 0 ? `Add another (${inCart} in cart)` : 'Add to cart';
}

function ProductCard({
  product,
  onAdd,
  quantity,
}: {
  product: Product;
  onAdd: (productId: string) => void;
  quantity: number;
}): ReactNode {
  const soldOut = product.stock < 1;

  return (
    <article className="card" style={{ '--hue': String(product.imageHue) } as React.CSSProperties}>
      <div className="swatch" aria-hidden="true" />
      <div className="card-body">
        <h3>{product.name}</h3>
        <p className="blurb">{product.blurb}</p>
        <p className="price">{money(product.priceCents)}</p>
        <details>
          <summary>Details</summary>
          <p className="detail">{product.description}</p>
          <ul className="flags">
            {product.finalSale && <li className="flag-warn">final sale</li>}
            {product.digital && <li className="flag-info">digital download</li>}
            {product.isSubscription && <li className="flag-info">subscription</li>}
            {product.stock < 20 && !product.digital && !product.isSubscription && (
              <li className="flag-warn">{product.stock} left</li>
            )}
          </ul>
        </details>
        {product.testsPolicy !== null && <p className="tests">Tests: {product.testsPolicy}</p>}
        <button type="button" disabled={soldOut} onClick={() => onAdd(product.id)}>
          {addLabel(soldOut, quantity)}
        </button>
      </div>
    </article>
  );
}
