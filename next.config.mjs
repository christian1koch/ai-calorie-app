/** @type {import('next').NextConfig} */
const nextConfig = {
  // setup for amazon bucket
  // images: {
  //   remotePatterns: [
  //     {
  //       protocol: "https",
  //       hostname: `${process.env.AWS_BUCKET_NAME}.s3.eu-north-1.amazonaws.com`,
  //       port: "", // leave empty if there's no specific port
  //       pathname: "/**", // allow all paths
  //     },
  //   ],
  // },
};

export default nextConfig;
