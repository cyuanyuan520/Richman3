import { Canvas } from '@react-three/fiber';

/**
 * Temporary bootstrap scene.
 *
 * It exists only to prove the Vite + React + React Three Fiber toolchain works
 * end to end. The real lobby / board / HUD replace it in later phases.
 */
export function App() {
  return (
    <div className="app-shell">
      <header className="app-shell__header">
        <h1>RichMan3</h1>
        <p>Q版 3D 大富翁 · 引导场景</p>
      </header>
      <div className="app-shell__viewport">
        <Canvas camera={{ position: [4, 4, 6], fov: 45 }} shadows>
          <color attach="background" args={['#8ecae6']} />
          <ambientLight intensity={0.9} />
          <directionalLight position={[5, 8, 4]} intensity={1.6} castShadow />
          <mesh castShadow position={[0, 0.5, 0]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color="#ffb703" />
          </mesh>
          <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[20, 20]} />
            <meshStandardMaterial color="#90be6d" />
          </mesh>
        </Canvas>
      </div>
    </div>
  );
}
